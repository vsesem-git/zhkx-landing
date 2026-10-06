<?php
/* ============================================================================
 *  api.php — СЕРВЕРНАЯ ЧАСТЬ «ЖКУ · Крым» ДЛЯ ОБЫЧНОГО ХОСТИНГА (PHP 7.4+)
 *  ---------------------------------------------------------------------------
 *  Ничего устанавливать не нужно: положите папку в каталог сайта и откройте её
 *  в браузере. Данные (журнал, авансы, показания, настройки) хранятся рядом,
 *  в исполняемом js-файле:
 *
 *      zhkx-data/state.js             window.ZHKX.StateData = { … }
 *      zhkx-data/history/*.js         до 60 предыдущих ревизий (для откатов)
 *      zhkx-data/auth.json            токен доступа (появляется после «Закрыть паролем»)
 *
 *  Формат файла состояния совпадает с Node-версией (server/store.js), поэтому
 *  данные можно переносить между хостингом и сервером Node без конвертации.
 *
 *  Проверка работы: откройте в браузере адрес папки + /api.php — увидите
 *  страницу состояния сервера (ревизия, размер, защита каталога данных).
 *
 *  Маршруты (совместимы с assets/js/core/sync.js):
 *    GET  api.php?route=health                 публично: состояние сервера
 *    POST api.php?route=login                  проверка токена
 *    POST api.php?route=lock                   «закрыть паролем»: выдать токен
 *    GET  api.php?route=state                  всё состояние + ревизия
 *    POST api.php?route=events                 пачка операций клиента (идемпотентно)
 *    GET  api.php?route=config                 справочники из data-слоя
 *    GET  api.php?route=reminders              напоминания (показания, поверки, долги)
 *    POST api.php?route=reminders/send         отправка в Telegram (если настроен)
 *    GET  api.php?route=revisions              список ревизий
 *    GET  api.php?route=revisions/<file>       скачать ревизию
 *    POST api.php?route=restore                откат к ревизии
 *    GET  api.php?route=export                 резервная копия JSON
 *    GET  api.php?route=state-file&token=…     скачать сам файл state.js
 *    POST api.php?route=import                 заменить состояние из бэкапа
 *    POST api.php?route=reset                  очистить пользовательские данные
 * ========================================================================== */

declare(strict_types=1);

const APP_VERSION = '2.1.0';
const APP_ID = 'zhkx-crimea';
const MARKER = 'window.ZHKX.StateData = ';

$ROOT = __DIR__;
$DATA_DIR = $ROOT . '/zhkx-data';
$STATE_FILE = $DATA_DIR . '/state.js';
$HISTORY_DIR = $DATA_DIR . '/history';
$AUTH_FILE = $DATA_DIR . '/auth.json';
$LOCK_FILE = $DATA_DIR . '/.lock';
$CONFIG_PHP = $DATA_DIR . '/config.php';       // необязательные настройки (токен, Telegram)
$CONFIG_JSON = $ROOT . '/config.generated.json'; // справочники, собранные при сборке папки

$STARTED_AT = microtime(true);

/* ==========================================================================
 *  МЕЛКИЕ ХЕЛПЕРЫ
 * ========================================================================== */

function out_json($payload, int $status = 200, array $headers = []): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    foreach ($headers as $name => $value) {
        header($name . ': ' . $value);
    }
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
    exit;
}

function fail(string $message, int $status = 400, array $extra = []): void
{
    out_json(array_merge(['ok' => false, 'error' => $message], $extra), $status);
}

function iso_now(): string
{
    return gmdate('Y-m-d\TH:i:s') . '.' . sprintf('%03d', (int) round((microtime(true) - floor(microtime(true))) * 1000)) . 'Z';
}

function stamp_now(): string
{
    return date('Ymd-His');
}

function pad_num(int $n, int $width): string
{
    return str_pad((string) $n, $width, '0', STR_PAD_LEFT);
}

function ensure_dirs(): void
{
    global $DATA_DIR, $HISTORY_DIR;
    foreach ([$DATA_DIR, $HISTORY_DIR] as $dir) {
        if (!is_dir($dir)) {
            @mkdir($dir, 0775, true);
        }
    }
}

/** Последовательный доступ к файлу состояния (чтобы не потерять правки) */
function with_lock(callable $fn)
{
    global $LOCK_FILE;
    ensure_dirs();
    $handle = @fopen($LOCK_FILE, 'c');
    if (!$handle) {
        fail('Каталог zhkx-data недоступен для записи. Дайте права на запись (chmod 775 zhkx-data).', 500);
    }
    flock($handle, LOCK_EX);
    try {
        return $fn();
    } finally {
        flock($handle, LOCK_UN);
        fclose($handle);
    }
}

function read_body_json(): array
{
    $raw = file_get_contents('php://input');
    if ($raw === false || $raw === '') {
        return [];
    }
    $data = json_decode($raw, true);
    if (!is_array($data)) {
        fail('Тело запроса не является JSON', 400);
    }
    return $data;
}

/* ==========================================================================
 *  СОСТОЯНИЕ: чтение, запись, ревизии
 * ========================================================================== */

function empty_state(): array
{
    $now = iso_now();
    return [
        'meta' => [
            'appId' => APP_ID,
            'schemaVersion' => 1,
            'revision' => 0,
            'createdAt' => $now,
            'updatedAt' => $now,
        ],
        'settings' => [],
        'objects' => [],
        'movements' => [],
        'journal' => [],
        'meterSnapshots' => [],
        'tombstones' => [],
        'outbox' => [],
    ];
}

function normalize_state($data): array
{
    $state = is_array($data) ? $data : empty_state();
    $base = empty_state();
    $state['meta'] = array_merge($base['meta'], is_array($state['meta'] ?? null) ? $state['meta'] : []);
    $state['settings'] = is_array($state['settings'] ?? null) ? $state['settings'] : [];
    $state['objects'] = is_array($state['objects'] ?? null) ? $state['objects'] : [];
    $state['movements'] = array_values(is_array($state['movements'] ?? null) ? $state['movements'] : []);
    $state['journal'] = array_values(is_array($state['journal'] ?? null) ? $state['journal'] : []);
    $state['meterSnapshots'] = is_array($state['meterSnapshots'] ?? null) ? $state['meterSnapshots'] : [];
    $state['tombstones'] = is_array($state['tombstones'] ?? null) ? $state['tombstones'] : [];
    unset($state['outbox']); // очередь операций живёт только в браузере
    return $state;
}

/** Пустые отображения должны сериализоваться как {}, а не [] */
function state_for_json(array $state): array
{
    $state['settings'] = (object) ($state['settings'] ?? []);
    $state['objects'] = (object) ($state['objects'] ?? []);
    $state['meterSnapshots'] = (object) ($state['meterSnapshots'] ?? []);
    $state['tombstones'] = (object) ($state['tombstones'] ?? []);

    $objects = [];
    foreach ((array) $state['objects'] as $id => $object) {
        $object = is_array($object) ? $object : [];
        $overrides = is_array($object['overrides'] ?? null) ? $object['overrides'] : [];
        $overrides['services'] = (object) ($overrides['services'] ?? []);
        if (!array_key_exists('area', $overrides)) {
            $overrides['area'] = null;
        }
        $object['overrides'] = $overrides;
        if (!array_key_exists('waterSchedule', $object)) {
            $object['waterSchedule'] = null;
        }
        if (!array_key_exists('notes', $object)) {
            $object['notes'] = null;
        }
        $objects[$id] = $object;
    }
    $state['objects'] = (object) $objects;

    $snapshots = [];
    foreach ((array) $state['meterSnapshots'] as $id => $bucket) {
        $snapshots[$id] = (object) (is_array($bucket) ? $bucket : []);
    }
    $state['meterSnapshots'] = (object) $snapshots;

    $state['journal'] = array_values($state['journal']);
    $state['movements'] = array_values($state['movements']);
    return $state;
}

function checksum_of(array $state): string
{
    $json = json_encode(state_for_json($state), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    return 'sha256:' . hash('sha256', (string) $json);
}

/** Запись .js-файла ровно в том же формате, что и Node-версия */
function serialize_state(array $state): string
{
    $json = json_encode(state_for_json($state), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
    $rev = (int) ($state['meta']['revision'] ?? 0);
    $updated = (string) ($state['meta']['updatedAt'] ?? iso_now());
    $sum = checksum_of($state);

    return implode("\n", [
        '/* ============================================================================',
        ' *  state.js — ЖУРНАЛ НАЧИСЛЕНИЙ, АВАНСОВЫЕ КОШЕЛЬКИ И ПОКАЗАНИЯ ПУ',
        ' *  ----------------------------------------------------------------------------',
        ' *  Файл создаётся и перезаписывается автоматически сервером (api.php).',
        ' *  Руками править не нужно: при следующем сохранении изменения будут потеряны.',
        ' *  Для правки используйте интерфейс приложения.',
        ' *',
        ' *  revision  : ' . $rev,
        ' *  updatedAt : ' . $updated,
        ' *  checksum  : ' . $sum,
        ' * ==========================================================================*/',
        'window.ZHKX = window.ZHKX || {};',
        MARKER . $json . ';',
        "if (typeof module !== 'undefined' && module.exports) module.exports = window.ZHKX.StateData;",
        '',
    ]);
}

/** Разбор .js-файла без исполнения кода: ищем сбалансированный объект */
function parse_state_js(string $text): array
{
    $at = strpos($text, MARKER);
    if ($at === false) {
        throw new RuntimeException('Не найден маркер ' . trim(MARKER) . ' в файле состояния');
    }
    $start = strpos($text, '{', $at);
    if ($start === false) {
        throw new RuntimeException('Не найден объект состояния');
    }

    $depth = 0;
    $inString = false;
    $escaped = false;
    $end = -1;
    $length = strlen($text);
    for ($i = $start; $i < $length; $i++) {
        $ch = $text[$i];
        if ($inString) {
            if ($escaped) {
                $escaped = false;
            } elseif ($ch === '\\') {
                $escaped = true;
            } elseif ($ch === '"') {
                $inString = false;
            }
            continue;
        }
        if ($ch === '"') { $inString = true; continue; }
        if ($ch === '{' || $ch === '[') { $depth++; }
        elseif ($ch === '}' || $ch === ']') {
            $depth--;
            if ($depth === 0) { $end = $i + 1; break; }
        }
    }
    if ($end === -1) {
        throw new RuntimeException('Объект состояния не закрыт');
    }
    $decoded = json_decode(substr($text, $start, $end - $start), true);
    if (!is_array($decoded)) {
        throw new RuntimeException('Не удалось разобрать состояние: ' . json_last_error_msg());
    }
    return normalize_state($decoded);
}

/** Читает состояние с диска (создаёт пустое при первом обращении) */
function read_state(): array
{
    global $STATE_FILE;
    ensure_dirs();
    if (!is_file($STATE_FILE)) {
        $fresh = empty_state();
        write_state_file($fresh);
        return $fresh;
    }
    $text = (string) file_get_contents($STATE_FILE);
    try {
        return parse_state_js($text);
    } catch (Throwable $e) {
        /* Битый файл: сохраняем копию и поднимаем чистый, чтобы приложение работало */
        $broken = $STATE_FILE . '.broken-' . stamp_now() . '.txt';
        @copy($STATE_FILE, $broken);
        $fresh = empty_state();
        write_state_file($fresh);
        return $fresh;
    }
}

function write_state_file(array $state): void
{
    global $STATE_FILE;
    ensure_dirs();
    $tmp = $STATE_FILE . '.tmp';
    if (file_put_contents($tmp, serialize_state($state), LOCK_EX) === false) {
        throw new RuntimeException('Не удалось записать zhkx-data/state.js');
    }
    if (!@rename($tmp, $STATE_FILE)) {
        @unlink($tmp);
        throw new RuntimeException('Не удалось заменить zhkx-data/state.js');
    }
    @chmod($STATE_FILE, 0664);
}

/** Сохранить состояние: новая ревизия + копия в историю */
function persist_state(array &$state, string $reason = 'events'): array
{
    global $HISTORY_DIR;
    $state['meta']['revision'] = (int) ($state['meta']['revision'] ?? 0) + 1;
    $state['meta']['updatedAt'] = iso_now();
    write_state_file($state);

    $file = 'state-' . pad_num((int) $state['meta']['revision'], 5) . '-' . stamp_now() . '.js';
    copy_file_to_history($file);
    prune_history();

    return [
        'revision' => (int) $state['meta']['revision'],
        'updatedAt' => $state['meta']['updatedAt'],
        'checksum' => checksum_of($state),
        'historyFile' => $file,
        'reason' => $reason,
        'state' => $state,   /* состояние уже с новой ревизией — отдаём вызывающему */
    ];
}

function copy_file_to_history(string $name): void
{
    global $STATE_FILE, $HISTORY_DIR;
    @copy($STATE_FILE, $HISTORY_DIR . '/' . $name);
}

function history_limit(): int
{
    $config = load_config_php();
    $limit = (int) ($config['history_limit'] ?? 60);
    return max(5, min(500, $limit));
}

function prune_history(): void
{
    global $HISTORY_DIR;
    $files = glob($HISTORY_DIR . '/state-*.js') ?: [];
    if (count($files) <= history_limit()) {
        return;
    }
    sort($files);
    $extra = count($files) - history_limit();
    for ($i = 0; $i < $extra; $i++) {
        @unlink($files[$i]);
    }
}

function list_revisions(int $limit = 50): array
{
    global $HISTORY_DIR;
    ensure_dirs();
    $files = glob($HISTORY_DIR . '/state-*.js') ?: [];
    rsort($files);
    $list = [];
    foreach (array_slice($files, 0, max(1, min(200, $limit))) as $path) {
        $name = basename($path);
        $item = [
            'file' => $name,
            'size' => (int) @filesize($path),
            'mtime' => gmdate('Y-m-d\TH:i:s\Z', (int) @filemtime($path)),
        ];
        try {
            $data = parse_state_js((string) file_get_contents($path));
            $item['revision'] = (int) $data['meta']['revision'];
            $item['updatedAt'] = $data['meta']['updatedAt'];
            $item['journal'] = count($data['journal']);
            $item['movements'] = count($data['movements']);
        } catch (Throwable $e) {
            $item['error'] = $e->getMessage();
        }
        $list[] = $item;
    }
    return $list;
}

function read_revision_file(string $name): array
{
    global $HISTORY_DIR;
    $safe = basename($name);
    if (!preg_match('/^state-\d+[-0-9]*\.js$/', $safe)) {
        fail('Некорректное имя ревизии', 400);
    }
    $path = $HISTORY_DIR . '/' . $safe;
    if (!is_file($path)) {
        fail('Ревизия не найдена: ' . $safe, 404);
    }
    $text = (string) file_get_contents($path);
    return ['file' => $safe, 'text' => $text, 'data' => parse_state_js($text)];
}

/* ==========================================================================
 *  ОПЕРАЦИИ КЛИЕНТА (идемпотентно: last-write-wins + надгробия)
 * ========================================================================== */

function tombstone_get(array $doc, string $key): ?string
{
    $value = $doc['tombstones'][$key] ?? null;
    return is_string($value) ? $value : null;
}

function tombstone_set(array &$doc, string $key, string $at): void
{
    $current = tombstone_get($doc, $key);
    if ($current === null || $current < $at) {
        $doc['tombstones'][$key] = $at;
    }
}

function is_buried(array $doc, string $key, string $at): bool
{
    $stamp = tombstone_get($doc, $key);
    return $stamp !== null && $stamp >= (string) $at;
}

function upsert_entity(array &$doc, string $collection, array $entity, string $kind, string $at, array &$applied, array &$skipped, bool &$changed): void
{
    $id = (string) ($entity['id'] ?? '');
    if ($id === '') {
        $skipped[] = ['reason' => 'no-id', 'type' => $kind];
        return;
    }
    if (is_buried($doc, $kind . ':' . $id, $at)) {
        $skipped[] = ['id' => $id, 'reason' => 'deleted-later', 'type' => $kind];
        return;
    }
    $entity['updatedAt'] = $at;
    foreach ($doc[$collection] as $index => $existing) {
        if (($existing['id'] ?? null) === $id) {
            $existingAt = (string) ($existing['updatedAt'] ?? $existing['createdAt'] ?? '');
            if ($at < $existingAt) {
                $skipped[] = ['id' => $id, 'reason' => 'older', 'type' => $kind];
                return;
            }
            if (json_encode($existing) === json_encode($entity)) {
                $applied[] = ['id' => $id, 'action' => 'unchanged', 'type' => $kind];
                return;
            }
            $doc[$collection][$index] = $entity;
            $changed = true;
            $applied[] = ['id' => $id, 'action' => 'updated', 'type' => $kind];
            return;
        }
    }
    $doc[$collection][] = $entity;
    $changed = true;
    $applied[] = ['id' => $id, 'action' => 'created', 'type' => $kind];
}

function remove_entity(array &$doc, string $collection, string $id, string $kind, string $at, array &$applied, array &$skipped, bool &$changed): void
{
    tombstone_set($doc, $kind . ':' . $id, $at);
    $before = count($doc[$collection]);
    $doc[$collection] = array_values(array_filter($doc[$collection], function ($item) use ($id) {
        return ($item['id'] ?? null) !== $id;
    }));
    if ($kind === 'entry') {
        $doc['movements'] = array_values(array_filter($doc['movements'], function ($movement) use ($id) {
            return !(($movement['kind'] ?? null) === 'charge' && ($movement['entryId'] ?? null) === $id);
        }));
    }
    if (count($doc[$collection]) !== $before) {
        $changed = true;
        $applied[] = ['id' => $id, 'action' => 'deleted', 'type' => $kind];
    } else {
        $applied[] = ['id' => $id, 'action' => 'delete-noop', 'type' => $kind];
    }
}

function apply_ops(array $data, array $ops): array
{
    $doc = normalize_state($data);
    $applied = [];
    $skipped = [];
    $changed = false;

    foreach ($ops as $index => $op) {
        if (!is_array($op) || empty($op['type'])) {
            $skipped[] = ['index' => $index, 'reason' => 'malformed'];
            continue;
        }
        $type = (string) $op['type'];
        $at = (string) ($op['at'] ?? iso_now());
        $payload = is_array($op['payload'] ?? null) ? $op['payload'] : [];

        switch ($type) {
            case 'upsert-entry':
                upsert_entity($doc, 'journal', $payload, 'entry', $at, $applied, $skipped, $changed);
                break;

            case 'delete-entry':
                remove_entity($doc, 'journal', (string) ($payload['id'] ?? ''), 'entry', $at, $applied, $skipped, $changed);
                break;

            case 'upsert-movement':
                upsert_entity($doc, 'movements', $payload, 'movement', $at, $applied, $skipped, $changed);
                break;

            case 'delete-movement':
                remove_entity($doc, 'movements', (string) ($payload['id'] ?? ''), 'movement', $at, $applied, $skipped, $changed);
                break;

            case 'set-object':
                $objectId = (string) ($payload['objectId'] ?? '');
                if ($objectId === '') { $skipped[] = ['reason' => 'no-object-id', 'type' => 'object']; break; }
                if (is_buried($doc, 'object:' . $objectId, $at)) { $skipped[] = ['id' => $objectId, 'reason' => 'deleted-later', 'type' => 'object']; break; }
                $current = $doc['objects'][$objectId] ?? ['overrides' => ['area' => null, 'services' => []], 'waterSchedule' => null, 'notes' => null];
                $currentAt = (string) ($current['_updatedAt'] ?? '');
                if ($at < $currentAt) { $skipped[] = ['id' => $objectId, 'reason' => 'older', 'type' => 'object']; break; }
                $patch = is_array($payload['patch'] ?? null) ? $payload['patch'] : [];
                $merged = array_merge($current, $patch);
                if (isset($patch['overrides']) && is_array($patch['overrides'])) {
                    $before = is_array($current['overrides'] ?? null) ? $current['overrides'] : [];
                    $services = array_merge(
                        is_array($before['services'] ?? null) ? $before['services'] : [],
                        is_array($patch['overrides']['services'] ?? null) ? $patch['overrides']['services'] : []
                    );
                    $merged['overrides'] = array_merge($before, $patch['overrides'], ['services' => $services]);
                }
                $merged['_updatedAt'] = $at;
                $doc['objects'][$objectId] = $merged;
                $changed = true;
                $applied[] = ['id' => $objectId, 'action' => 'updated', 'type' => 'object'];
                break;

            case 'set-settings':
                $currentAt = (string) ($doc['settings']['_updatedAt'] ?? '');
                if ($at < $currentAt) { $skipped[] = ['id' => 'settings', 'reason' => 'older', 'type' => 'settings']; break; }
                $patch = is_array($payload['patch'] ?? null) ? $payload['patch'] : [];
                $doc['settings'] = array_merge($doc['settings'], $patch, ['_updatedAt' => $at]);
                $changed = true;
                $applied[] = ['id' => 'settings', 'action' => 'updated', 'type' => 'settings'];
                break;

            case 'set-snapshot':
                $objectId = (string) ($payload['objectId'] ?? '');
                $serviceId = (string) ($payload['serviceId'] ?? '');
                if ($objectId === '' || $serviceId === '') { $skipped[] = ['reason' => 'no-id', 'type' => 'snapshot']; break; }
                $bucket = $doc['meterSnapshots'][$objectId] ?? [];
                $current = is_array($bucket[$serviceId] ?? null) ? $bucket[$serviceId] : [];
                if ($at < (string) ($current['_updatedAt'] ?? '')) {
                    $skipped[] = ['id' => $objectId . '/' . $serviceId, 'reason' => 'older', 'type' => 'snapshot'];
                    break;
                }
                $patch = is_array($payload['patch'] ?? null) ? $payload['patch'] : [];
                $bucket[$serviceId] = array_merge($current, $patch, ['_updatedAt' => $at]);
                $doc['meterSnapshots'][$objectId] = $bucket;
                $changed = true;
                $applied[] = ['id' => $objectId . '/' . $serviceId, 'action' => 'updated', 'type' => 'snapshot'];
                break;

            case 'replace-state':
                $incoming = normalize_state(is_array($payload['state'] ?? null) ? $payload['state'] : []);
                $incoming['meta']['revision'] = (int) ($doc['meta']['revision'] ?? 0);
                $incoming['meta']['createdAt'] = (string) ($doc['meta']['createdAt'] ?? iso_now());
                $doc = $incoming;
                $changed = true;
                $applied[] = ['id' => 'state', 'action' => 'replaced', 'type' => 'state', 'journal' => count($doc['journal'])];
                break;

            default:
                $skipped[] = ['index' => $index, 'reason' => 'unknown-type:' . $type];
        }
    }

    return ['data' => $doc, 'applied' => $applied, 'skipped' => $skipped, 'changed' => $changed];
}

/* ==========================================================================
 *  ДОСТУП: токен, «открытый» режим, блокировка
 * ========================================================================== */

function load_config_php(): array
{
    global $CONFIG_PHP;
    if (!is_file($CONFIG_PHP)) {
        return [];
    }
    $value = @include $CONFIG_PHP;
    return is_array($value) ? $value : [];
}

function load_auth(): array
{
    global $AUTH_FILE;
    $config = load_config_php();
    if (!empty($config['token'])) {
        return ['token' => (string) $config['token'], 'mode' => 'locked', 'source' => 'config.php'];
    }
    if (is_file($AUTH_FILE)) {
        $parsed = json_decode((string) @file_get_contents($AUTH_FILE), true);
        if (is_array($parsed) && !empty($parsed['token'])) {
            return ['token' => (string) $parsed['token'], 'mode' => 'locked', 'source' => 'auth.json', 'createdAt' => $parsed['createdAt'] ?? null];
        }
    }
    return ['token' => '', 'mode' => 'open', 'source' => 'default'];
}

function save_auth(string $token): array
{
    global $AUTH_FILE;
    ensure_dirs();
    $auth = ['token' => $token, 'createdAt' => iso_now(), 'note' => 'Токен доступа к API ЖКУ. Удалите файл, чтобы снова открыть доступ без пароля.'];
    @file_put_contents($AUTH_FILE, json_encode($auth, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT), LOCK_EX);
    @chmod($AUTH_FILE, 0600);
    return $auth;
}

function token_from_request(): ?string
{
    $header = $_SERVER['HTTP_AUTHORIZATION'] ?? ($_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '');
    if (is_string($header) && preg_match('/^Bearer\s+(.+)$/i', trim($header), $m)) {
        return trim($m[1]);
    }
    if (!empty($_GET['token'])) {
        return trim((string) $_GET['token']);
    }
    return null;
}

function require_auth(): array
{
    $auth = load_auth();
    if ($auth['mode'] === 'open') {
        return $auth; // сервер ещё не закрыт паролем — пускаем (в интерфейсе об этом предупреждаем)
    }
    $token = token_from_request();
    if ($token !== null && hash_equals((string) $auth['token'], $token)) {
        return $auth;
    }
    fail('Требуется токен доступа. Он лежит в zhkx-data/auth.json (или задан в zhkx-data/config.php).', 401);
}

/* ==========================================================================
 *  ЗАЩИТА КАТАЛОГА ДАННЫХ (диагностика)
 * ========================================================================== */

/**
 * Проверяет, отдаёт ли веб-сервер файл состояния напрямую (без токена).
 * Результат кэшируется на час, чтобы не тормозить каждый запрос.
 */
function exposure_status(): ?bool
{
    global $DATA_DIR;
    $cacheFile = $DATA_DIR . '/.exposure.json';
    if (is_file($cacheFile)) {
        $cached = json_decode((string) @file_get_contents($cacheFile), true);
        if (is_array($cached) && isset($cached['checkedAt']) && (time() - (int) $cached['checkedAt']) < 3600) {
            return $cached['exposed'] === null ? null : (bool) $cached['exposed'];
        }
    }

    /* Однопоточный встроенный сервер PHP (`php -S`) не может обслужить запрос
       к самому себе: там проверку делает браузер (core/sync.js) — не висим 1.5 с. */
    $software = (string) ($_SERVER['SERVER_SOFTWARE'] ?? '');
    if (stripos($software, 'Development Server') !== false) {
        return null;
    }

    $dir = rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? '/')), '/');
    $host = $_SERVER['HTTP_HOST'] ?? '';
    $https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
    $result = null;

    if ($host !== '' && function_exists('file_get_contents')) {
        $url = ($https ? 'https://' : 'http://') . $host . $dir . '/zhkx-data/state.js';
        $context = stream_context_create(['http' => ['timeout' => 1.5, 'ignore_errors' => true, 'method' => 'GET']]);
        $body = @file_get_contents($url, false, $context);
        if ($body !== false) {
            $result = strpos($body, 'StateData') !== false;
        }
    }

    @file_put_contents($cacheFile, json_encode(['checkedAt' => time(), 'exposed' => $result, 'url' => $url ?? null]), LOCK_EX);
    return $result;
}

/* ==========================================================================
 *  СПРАВОЧНИКИ ИЗ DATA-СЛОЯ (файл собирается при сборке папки)
 * ========================================================================== */

function config_json(): array
{
    global $CONFIG_JSON;
    if (!is_file($CONFIG_JSON)) {
        return ['objects' => [], 'generatedAt' => null];
    }
    $data = json_decode((string) file_get_contents($CONFIG_JSON), true);
    return is_array($data) ? $data : ['objects' => []];
}

/* ==========================================================================
 *  НАПОМИНАНИЯ (показания, поверки, деньги)
 * ========================================================================== */

function month_name(int $month): string
{
    $names = [1 => 'января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
    return $names[$month] ?? (string) $month;
}

function days_until(string $dateISO): ?int
{
    $ts = strtotime($dateISO . ' 00:00:00');
    if ($ts === false) {
        return null;
    }
    $today = strtotime(date('Y-m-d') . ' 00:00:00');
    return (int) floor(($ts - $today) / 86400);
}

function add_years(string $dateISO, int $years): string
{
    $ts = strtotime($dateISO . ' 12:00:00');
    if ($ts === false) {
        return $dateISO;
    }
    return date('Y-m-d', strtotime('+' . $years . ' years', $ts));
}

function money(float $value): string
{
    return number_format($value, 2, ',', ' ') . ' ₽';
}

function build_reminders(): array
{
    $state = read_state();
    $config = config_json();
    $objects = $config['objects'] ?? [];
    $list = [];

    $period = date('Y-m');
    $day = (int) date('j');
    $inWindow = $day >= 20 && $day <= 25;
    $monthLabel = month_name((int) date('n')) . ' ' . date('Y');

    /* 1. Передача показаний приборов учёта */
    $missing = [];
    foreach ($objects as $object) {
        foreach (($object['services'] ?? []) as $serviceId => $service) {
            /* показания передают по приборам учёта: электричество и вода */
            if ($serviceId !== 'electricity' && $serviceId !== 'water') {
                continue;
            }
            if (isset($service['enabled']) && !$service['enabled']) {
                continue;
            }
            $has = false;
            foreach ($state['journal'] as $entry) {
                if (($entry['objectId'] ?? null) === ($object['id'] ?? null)
                    && ($entry['serviceId'] ?? null) === $serviceId
                    && ($entry['period'] ?? null) === $period) {
                    $has = true;
                    break;
                }
            }
            if (!$has) {
                $missing[] = '№' . ($object['index'] ?? '?') . ' ' . ($object['label'] ?? '');
            }
        }
    }
    $list[] = $missing
        ? ['level' => $inWindow ? 'warn' : 'info', 'title' => 'Передача показаний за ' . $monthLabel,
           'text' => 'не внесено по ' . count($missing) . ' объект(ам): ' . implode(', ', array_slice($missing, 0, 6))
               . ($inWindow ? ' — до 25 числа включительно' : ' — окно передачи 20–25 число')]
        : ['level' => 'ok', 'title' => 'Показания за ' . $monthLabel, 'text' => 'внесены по всем объектам'];

    /* 2. Госповерка приборов учёта */
    foreach ($objects as $object) {
        foreach (($object['services'] ?? []) as $serviceId => $service) {
            $meter = $service['meter'] ?? null;
            if (!$meter || empty($meter['lastCheckDate']) || empty($meter['checkPeriodYears'])) {
                continue;
            }
            $next = add_years((string) $meter['lastCheckDate'], (int) $meter['checkPeriodYears']);
            $days = days_until($next);
            if ($days === null) {
                continue;
            }
            $who = '№' . ($object['index'] ?? '?') . ' ' . ($object['label'] ?? '')
                . ' · ' . ($serviceId === 'water' ? 'вода' : 'электроэнергия')
                . ($meter['serial'] ? ' (№ ' . $meter['serial'] . ')' : '');
            if ($days < 0) {
                $list[] = ['level' => 'danger', 'title' => 'Поверка истекла',
                    'text' => $who . ': срок истёк ' . abs($days) . ' дн. назад (' . date('d.m.Y', strtotime($next)) . ')'];
            } elseif ($days <= 7) {
                $list[] = ['level' => 'warn', 'title' => 'Поверка срочно',
                    'text' => $who . ': осталось ' . $days . ' дн. (до ' . date('d.m.Y', strtotime($next)) . ') — вызывайте метролога'];
            } elseif ($days <= 30) {
                $list[] = ['level' => 'warn', 'title' => 'Скоро поверка',
                    'text' => $who . ': осталось ' . $days . ' дн. (до ' . date('d.m.Y', strtotime($next)) . ')'];
            }
        }
    }

    /* 3. Деньги: задолженность и заканчивающийся аванс */
    $balances = [];
    foreach ($state['movements'] as $movement) {
        $key = ($movement['objectId'] ?? '') . '|' . ($movement['serviceId'] ?? '');
        $balances[$key] = ($balances[$key] ?? 0) + (float) ($movement['amount'] ?? 0);
    }
    foreach ($balances as $key => $balance) {
        [$objectId, $serviceId] = array_pad(explode('|', (string) $key, 2), 2, '');
        $object = null;
        foreach ($objects as $candidate) {
            if (($candidate['id'] ?? null) === $objectId) { $object = $candidate; break; }
        }
        $who = $object ? ('№' . ($object['index'] ?? '?') . ' ' . ($object['label'] ?? '')) : $objectId;
        $serviceLabel = $serviceId === 'caprepair' ? 'капремонт' : ($serviceId === 'maintenance' ? 'содержание' : ($serviceId === 'water' ? 'вода' : ($serviceId === 'electricity' ? 'электроэнергия' : $serviceId)));

        /* средний месячный платёж по последним 6 месяцам */
        $sums = [];
        foreach ($state['journal'] as $entry) {
            if (($entry['objectId'] ?? null) !== $objectId || ($entry['serviceId'] ?? null) !== $serviceId) {
                continue;
            }
            $sums[(string) $entry['period']] = (float) ($entry['amount'] ?? 0);
        }
        ksort($sums);
        $recent = array_slice(array_values($sums), -6);
        $avg = $recent ? array_sum($recent) / count($recent) : 0.0;

        if ($balance < -1) {
            $list[] = ['level' => 'warn', 'title' => 'Задолженность',
                'text' => $who . ' · ' . $serviceLabel . ': ' . money(abs($balance)) . ' к оплате'];
        } elseif ($balance > 0 && $avg > 0) {
            $months = $balance / $avg;
            if ($months < 1.5) {
                $list[] = ['level' => 'warn', 'title' => 'Заканчивается аванс',
                    'text' => $who . ' · ' . $serviceLabel . ': ' . money($balance) . ' — примерно на ' . number_format($months, 1, ',', ' ') . ' мес.'];
            }
        }
    }

    if (!$list) {
        $list[] = ['level' => 'ok', 'title' => 'Всё в порядке', 'text' => 'показания внесены, поверки в срок, долгов нет'];
    }
    return $list;
}

function telegram_config(): array
{
    $config = load_config_php();
    return is_array($config['telegram'] ?? null) ? $config['telegram'] : [];
}

function telegram_configured(): bool
{
    $t = telegram_config();
    return !empty($t['token']) && !empty($t['chat']);
}

function to_telegram_text(array $list): string
{
    $head = '🏠 ЖКУ · Крым — напоминания на ' . date('d.m.Y');
    $icons = ['danger' => '❌', 'warn' => '⚠️', 'info' => 'ℹ️', 'ok' => '✅'];
    $lines = [];
    foreach ($list as $item) {
        if (($item['level'] ?? '') === 'ok') {
            continue;
        }
        $lines[] = ($icons[$item['level']] ?? '•') . ' *' . $item['title'] . "*\n" . $item['text'];
    }
    if (!$lines) {
        return $head . "\n\n✅ Всё в порядке: показания внесены, поверки в срок, долгов нет.";
    }
    return $head . "\n\n" . implode("\n\n", $lines);
}

function send_telegram(string $text): array
{
    $t = telegram_config();
    if (empty($t['token']) || empty($t['chat'])) {
        return ['sent' => false, 'reason' => 'Telegram не настроен (см. zhkx-data/config.php)'];
    }
    $url = 'https://api.telegram.org/bot' . $t['token'] . '/sendMessage';
    $payload = http_build_query([
        'chat_id' => $t['chat'],
        'text' => $text,
        'parse_mode' => 'Markdown',
        'disable_web_page_preview' => 'true',
    ]);
    $context = stream_context_create(['http' => [
        'method' => 'POST',
        'header' => "Content-Type: application/x-www-form-urlencoded\r\n",
        'content' => $payload,
        'timeout' => 10,
        'ignore_errors' => true,
    ]]);
    $body = @file_get_contents($url, false, $context);
    $json = $body !== false ? json_decode((string) $body, true) : null;
    return ['sent' => is_array($json) && !empty($json['ok']), 'response' => is_array($json) ? ($json['description'] ?? null) : 'нет ответа'];
}

/* ==========================================================================
 *  МАРШРУТИЗАЦИЯ
 * ========================================================================== */

$route = isset($_GET['route']) ? trim((string) $_GET['route'], '/') : '';
$method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');

/* CORS: приложение отдаётся тем же хостингом, но адрес сервера можно указать вручную */
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Headers: Content-Type, Authorization');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
if ($method === 'OPTIONS') {
    http_response_code(204);
    exit;
}

/* Открыт сам api.php без маршрута — показываем страницу состояния сервера */
if ($route === '') {
    $state = read_state();
    $auth = load_auth();
    $exposed = exposure_status();
    $revisions = list_revisions(1);
    $size = is_file($STATE_FILE) ? (int) filesize($STATE_FILE) : 0;
    header('Content-Type: text/html; charset=utf-8');
    $badge = static function (bool $ok, string $text): string {
        return '<li>' . ($ok ? '✅' : '⚠️') . ' ' . htmlspecialchars($text, ENT_QUOTES, 'UTF-8') . '</li>';
    };
    $appDir = rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? '/')), '/') . '/';
    echo '<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">'
        . '<meta name="viewport" content="width=device-width, initial-scale=1">'
        . '<title>Сервер ЖКУ · Крым — состояние</title>'
        . '<style>body{font:15px/1.6 system-ui,sans-serif;margin:0;padding:2rem;background:#0b1220;color:#e6edf6}'
        . 'main{max-width:760px;margin:0 auto}a{color:#7dd3fc}code{background:#182338;padding:.1rem .35rem;border-radius:6px}'
        . 'ul{padding-left:1.2rem}h1{font-size:1.3rem}.muted{color:#8b9bb4;font-size:.9rem}'
        . '.btn{display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:.55rem .9rem;border-radius:10px;margin-top:.6rem}</style>'
        . '</head><body><main>'
        . '<h1>🏠 Сервер «ЖКУ · Крым» работает</h1>'
        . '<p><a class="btn" href="' . htmlspecialchars($appDir, ENT_QUOTES, 'UTF-8') . '">Открыть приложение →</a></p>'
        . '<ul>'
        . $badge(true, 'PHP ' . PHP_VERSION . ' · данные хранятся в zhkx-data/state.js')
        . $badge(true, 'Ревизия: ' . (int) $state['meta']['revision'] . ' · записей в журнале: ' . count($state['journal'])
            . ' · движений: ' . count($state['movements']) . ' · файл: ' . number_format($size / 1024, 1, ',', ' ') . ' КБ')
        . $badge($auth['mode'] === 'locked', $auth['mode'] === 'locked'
            ? 'Доступ закрыт токеном (' . $auth['source'] . ')'
            : 'Доступ открыт: закройте паролем в приложении («Сервер и синхронизация») или в zhkx-data/config.php')
        . ($revisions
            ? $badge($exposed !== true, $exposed === true
                ? 'ВНИМАНИЕ: файл zhkx-data/state.js отдаётся веб-сервером напрямую — закройте каталог (см. ПРОЧТИ-МЕНЯ.txt)'
                : ($exposed === false
                    ? 'Каталог zhkx-data защищён от прямого скачивания'
                    : 'Проверка защиты каталога данных недоступна (нет исходящих запросов) — см. ПРОЧТИ-МЕНЯ.txt'))
            : '')
        . $badge(true, 'История ревизий: ' . count(glob($HISTORY_DIR . '/state-*.js') ?: []) . ' файлов (лимит ' . history_limit() . ')')
        . '</ul>'
        . '<p class="muted">Каталог данных: <code>zhkx-data/</code> · версия приложения ' . APP_VERSION . '. '
        . 'Этот адрес можно использовать для проверки, что хостинг работает.</p>'
        . '</main></body></html>';
    exit;
}

try {
    switch ($route) {
        /* ---------------------------------------------------------- состояние сервера */
        case 'health': {
            $state = read_state();
            $auth = load_auth();
            $config = config_json();
            out_json([
                'ok' => true,
                'app' => [
                    'id' => APP_ID,
                    'version' => APP_VERSION,
                    'runtime' => 'php',
                    'storage' => 'php-js',
                    'stateFile' => 'zhkx-data/state.js',
                ],
                'server' => [
                    'software' => $_SERVER['SERVER_SOFTWARE'] ?? 'php',
                    'php' => PHP_VERSION,
                    'time' => iso_now(),
                    'uptimeSec' => (int) round(microtime(true) - $STARTED_AT),
                    'historyLimit' => history_limit(),
                ],
                'revision' => (int) $state['meta']['revision'],
                'updatedAt' => $state['meta']['updatedAt'],
                'checksum' => checksum_of($state),
                'size' => is_file($STATE_FILE) ? (int) filesize($STATE_FILE) : 0,
                'journal' => count($state['journal']),
                'movements' => count($state['movements']),
                'auth' => [
                    'authRequired' => $auth['mode'] === 'locked',
                    'open' => $auth['mode'] === 'open',
                    'demoAuth' => false,
                    'source' => $auth['source'],
                ],
                'notifications' => ['telegram' => telegram_configured()],
                'dataDirExposed' => exposure_status(),
                'config' => ['objects' => count($config['objects'] ?? []), 'generatedAt' => $config['generatedAt'] ?? null],
            ]);
        }

        /* ------------------------------------------------------------ вход по токену */
        case 'login': {
            $body = read_body_json();
            $token = trim((string) ($body['token'] ?? ''));
            $auth = load_auth();
            if ($auth['mode'] === 'open') {
                out_json(['ok' => true, 'message' => 'Сервер открыт: токен не требуется', 'open' => true]);
            }
            if ($token !== '' && hash_equals((string) $auth['token'], $token)) {
                out_json(['ok' => true, 'message' => 'Доступ разрешён']);
            }
            fail('Неверный токен доступа', 401);
        }

        /* ------------------------------------------- «закрыть паролем» / показать токен */
        case 'lock': {
            $auth = load_auth();
            if ($auth['mode'] === 'open') {
                $body = read_body_json();
                $token = trim((string) ($body['token'] ?? ''));
                if ($token === '') {
                    $token = bin2hex(random_bytes(16));
                } elseif (strlen($token) < 8) {
                    fail('Токен слишком короткий: минимум 8 символов', 400);
                }
                save_auth($token);
                out_json([
                    'ok' => true,
                    'token' => $token,
                    'authRequired' => true,
                    'message' => 'Доступ закрыт токеном. Сохраните его — он понадобится на других устройствах.',
                ]);
            }
            $given = token_from_request();
            if ($given !== null && hash_equals((string) $auth['token'], $given)) {
                out_json(['ok' => true, 'token' => $auth['token'], 'authRequired' => true, 'message' => 'Сервер уже закрыт этим токеном']);
            }
            fail('Сервер уже закрыт паролем. Токен лежит в zhkx-data/auth.json', 401);
        }

        /* ----------------------------------------------------------- состояние данных */
        case 'state': {
            require_auth();
            $state = read_state();
            out_json([
                'ok' => true,
                'revision' => (int) $state['meta']['revision'],
                'updatedAt' => $state['meta']['updatedAt'],
                'checksum' => checksum_of($state),
                'state' => state_for_json($state),
            ]);
        }

        /* --------------------------------------------- скачать сам .js-файл состояния */
        case 'state-file': {
            require_auth();
            header('Content-Type: application/javascript; charset=utf-8');
            header('Content-Disposition: attachment; filename="state.js"');
            header('Cache-Control: no-store');
            echo is_file($STATE_FILE) ? (string) file_get_contents($STATE_FILE) : serialize_state(read_state());
            exit;
        }

        /* ------------------------------------------------------ операции от браузера */
        case 'events': {
            require_auth();
            if ($method !== 'POST') {
                fail('Ожидается POST', 405);
            }
            $body = read_body_json();
            if (!isset($body['ops']) || !is_array($body['ops'])) {
                fail('Ожидается { ops: [...] }', 400);
            }
            $result = with_lock(function () use ($body) {
                $state = read_state();
                $base = (int) ($body['baseRevision'] ?? 0);
                $conflict = $base > 0 && $base !== (int) $state['meta']['revision'];
                $applied = apply_ops($state, $body['ops']);
                $saved = null;
                if ($applied['changed']) {
                    $payload = $applied['data'];
                    $saved = persist_state($payload, 'events');
                    $final = $saved['state'];
                } else {
                    $final = $state;
                }
                return [
                    'revision' => (int) $final['meta']['revision'],
                    'updatedAt' => $final['meta']['updatedAt'],
                    'checksum' => checksum_of($final),
                    'applied' => $applied['applied'],
                    'skipped' => $applied['skipped'],
                    'conflict' => $conflict ? ['serverRevision' => (int) $state['meta']['revision'], 'clientRevision' => $base] : null,
                    'historyFile' => $saved['historyFile'] ?? null,
                    'state' => state_for_json($final),
                ];
            });
            out_json(array_merge(['ok' => true], $result));
        }

        /* --------------------------------------------------------------- справочники */
        case 'config': {
            require_auth();
            $config = config_json();
            out_json([
                'ok' => true,
                'status' => ['generatedAt' => $config['generatedAt'] ?? null, 'objects' => count($config['objects'] ?? [])],
                'objects' => $config['objects'] ?? [],
                'tariffs' => $config['tariffs'] ?? [],
                'meters' => $config['meters'] ?? [],
                'validation' => $config['validation'] ?? ['ok' => true, 'problems' => []],
            ]);
        }

        /* --------------------------------------------------------------- напоминания */
        case 'reminders': {
            require_auth();
            $list = build_reminders();
            out_json([
                'ok' => true,
                'telegramConfigured' => telegram_configured(),
                'count' => count($list),
                'reminders' => $list,
                'preview' => to_telegram_text($list),
            ]);
        }

        case 'reminders/send': {
            require_auth();
            $list = build_reminders();
            $result = send_telegram(to_telegram_text($list));
            out_json(array_merge(['ok' => true, 'count' => count($list)], $result));
        }

        /* ------------------------------------------------------------------ ревизии */
        case 'revisions': {
            require_auth();
            $limit = (int) ($_GET['limit'] ?? 50);
            $state = read_state();
            out_json([
                'ok' => true,
                'revisions' => list_revisions($limit),
                'current' => (int) $state['meta']['revision'],
            ]);
        }

        case 'restore': {
            require_auth();
            if ($method !== 'POST') {
                fail('Ожидается POST', 405);
            }
            $body = read_body_json();
            $file = (string) ($body['file'] ?? '');
            $revision = read_revision_file($file);
            $result = with_lock(function () use ($revision) {
                $state = read_state();
                $incoming = normalize_state($revision['data']);
                $incoming['meta']['revision'] = (int) $state['meta']['revision'];
                $incoming['meta']['createdAt'] = (string) ($state['meta']['createdAt'] ?? iso_now());
                $saved = persist_state($incoming, 'restore');
                return ['revision' => $saved['revision'], 'updatedAt' => $saved['updatedAt'], 'state' => state_for_json($saved['state']), 'restoredFrom' => $revision['file']];
            });
            out_json(array_merge(['ok' => true], $result));
        }

        /* ------------------------------------------------------------ экспорт/импорт */
        case 'export': {
            require_auth();
            $state = read_state();
            out_json([
                'ok' => true,
                'format' => 'zhkx-crimea-backup',
                'formatVersion' => 1,
                'exportedAt' => iso_now(),
                'server' => ['runtime' => 'php', 'php' => PHP_VERSION, 'revision' => (int) $state['meta']['revision']],
                'summary' => [
                    'revision' => (int) $state['meta']['revision'],
                    'journalEntries' => count($state['journal']),
                    'movements' => count($state['movements']),
                    'objects' => count($state['objects']),
                ],
                'state' => state_for_json($state),
            ]);
        }

        case 'import': {
            require_auth();
            if ($method !== 'POST') {
                fail('Ожидается POST', 405);
            }
            $body = read_body_json();
            $incoming = $body['state'] ?? ($body['payload']['state'] ?? $body);
            if (!is_array($incoming) || !isset($incoming['journal']) || !is_array($incoming['journal'])) {
                fail('В файле нет состояния с журналом начислений', 400);
            }
            $result = with_lock(function () use ($incoming) {
                $state = read_state();
                $prepared = normalize_state($incoming);
                $prepared['meta']['revision'] = (int) $state['meta']['revision'];
                $prepared['meta']['createdAt'] = (string) ($state['meta']['createdAt'] ?? iso_now());
                $saved = persist_state($prepared, 'import');
                return ['revision' => $saved['revision'], 'journal' => count($prepared['journal']), 'movements' => count($prepared['movements']), 'objects' => count($prepared['objects'])];
            });
            out_json(array_merge(['ok' => true], $result));
        }

        case 'reset': {
            require_auth();
            $result = with_lock(function () {
                $state = read_state();
                $fresh = empty_state();
                $fresh['meta']['createdAt'] = (string) ($state['meta']['createdAt'] ?? iso_now());
                $saved = persist_state($fresh, 'reset');
                return ['revision' => $saved['revision'], 'journal' => 0, 'movements' => 0];
            });
            out_json(array_merge(['ok' => true], $result));
        }

        /* ------------------------------------------------------- скачать ревизию файлом */
        default: {
            if (strpos($route, 'revisions/') === 0) {
                require_auth();
                $revision = read_revision_file(substr($route, strlen('revisions/')));
                header('Content-Type: application/javascript; charset=utf-8');
                header('Cache-Control: no-store');
                echo $revision['text'];
                exit;
            }
            fail('Неизвестный маршрут: ' . $route, 404);
        }
    }
} catch (Throwable $e) {
    fail('Ошибка сервера: ' . $e->getMessage(), 500);
}
