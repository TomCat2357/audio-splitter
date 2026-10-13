// gas/Code.gs を node:vm に読み込んで動かすための「メモリ上の小さな Google ドライブ」と、GAS サービスのスタブ。
// 実際の Drive・GAS には一切アクセスしない。ID・メール・URL はすべて見るからにダミー。
//
// 作るもの:
//   createFakeDrive(opts)        メモリ上の Drive（ノードの木、再開可能アップロードのセッション、CacheService の中身、故障の注入）
//   createServer(fake, opts)     Code.gs を読み込み、呼び出しごとに「新しい実行コンテキスト」を作る（GAS は実行ごとにグローバル変数を引き継がない）
//
// スタブの限界は docs ではなくテストの報告に書いてある（Drive の実機との違い）。ここでは「サーバーが実際に発行するクエリ」だけを解釈し、
// 解釈できないクエリ・フィールド・引数は例外にして、テストが静かに通ってしまうのを防ぐ。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { bakeCodeGs } from '../bundle-gas.mjs';

const GAS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'gas');
export const SOURCE = fs.readFileSync(path.join(GAS_DIR, 'Code.gs'), 'utf8');

export const FOLDER_MIME = 'application/vnd.google-apps.folder';
export const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';
export const KB256 = 256 * 1024;
export const SECRET_TOKEN = 'FAKE-OAUTH-TOKEN-SECRET';
export const USER = 'user@example.test';
const UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable';

// ---------------------------------------------------------------- フィールド指定（fields=...）と q の解釈

/** 'a,b(c,d),e' → { a:true, b:{c:true,d:true}, e:true } */
export function parseFields(spec) {
  const s = String(spec || '');
  let i = 0;
  function list() {
    const out = {};
    while (i < s.length) {
      let name = '';
      while (i < s.length && !',()'.includes(s[i])) name += s[i++];
      name = name.trim();
      if (s[i] === '(') {
        i++;
        out[name] = list();
        i++; // ')'
      } else if (name) {
        out[name] = true;
      }
      if (s[i] === ',') i++;
      else if (s[i] === ')') return out;
    }
    return out;
  }
  return list();
}

/** 実 Drive は fields で頼んだ項目だけを返す。頼んでいない項目に依存するコードを検出するため、同じように絞る。 */
export function project(obj, tree) {
  if (tree === true || tree === undefined) return obj;
  if (Array.isArray(obj)) return obj.map((x) => project(x, tree));
  if (obj === null || typeof obj !== 'object') return obj;
  const out = {};
  for (const key of Object.keys(tree)) {
    if (key === '*') return obj;
    if (obj[key] !== undefined) out[key] = project(obj[key], tree[key]);
  }
  return out;
}

function tokenizeQ(q) {
  const toks = [];
  let i = 0;
  while (i < q.length) {
    const c = q[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '(' || c === ')' || c === '=' || c === '>') { toks.push({ t: c }); i++; continue; }
    if (c === "'") {
      let v = '';
      i++;
      while (i < q.length && q[i] !== "'") {
        if (q[i] === '\\') { i++; }
        v += q[i++];
      }
      if (q[i] !== "'") throw new Error('Invalid Value: 引用符が閉じていない q: ' + q);
      i++;
      toks.push({ t: 'str', v });
      continue;
    }
    const m = /^[A-Za-z_]+/.exec(q.slice(i));
    if (!m) throw new Error('Invalid Value: 解釈できない q: ' + q);
    toks.push({ t: 'word', v: m[0] });
    i += m[0].length;
  }
  return toks;
}

/** サーバーが発行する形の q だけを解釈する。{ test(node, fake), scoped } */
export function parseQ(q) {
  const toks = tokenizeQ(String(q || ''));
  let p = 0;
  const flags = { parents: false, name: false };
  const peek = () => toks[p];
  const eatWord = (w) => { const x = toks[p]; if (x && x.t === 'word' && x.v === w) { p++; return true; } return false; };
  const need = (t) => { const x = toks[p++]; if (!x || x.t !== t) throw new Error('Invalid Value: q の文法エラー: ' + q); return x; };

  function cond() {
    const x = toks[p++];
    if (!x) throw new Error('Invalid Value: q が途中で終わっている: ' + q);
    if (x.t === 'str') {
      if (!eatWord('in') || !eatWord('parents')) throw new Error('Invalid Value: 未対応の q: ' + q);
      flags.parents = true;
      return (n, f) => (n.parents || []).includes(x.v === 'root' ? f.rootId : x.v);
    }
    if (x.t !== 'word') throw new Error('Invalid Value: 未対応の q: ' + q);
    if (x.v === 'trashed') { need('='); const v = need('word').v; return (n) => !!n.trashed === (v === 'true'); }
    if (x.v === 'starred') { need('='); const v = need('word').v; return (n) => !!n.starred === (v === 'true'); }
    if (x.v === 'sharedWithMe') { need('='); const v = need('word').v; return (n) => !!n.sharedWithMe === (v === 'true'); }
    if (x.v === 'viewedByMeTime') {
      need('>');
      const v = Date.parse(need('str').v);
      return (n) => !!n.viewedByMeTime && Date.parse(n.viewedByMeTime) > v;
    }
    if (x.v === 'name') {
      if (!eatWord('contains')) throw new Error('Invalid Value: 未対応の q: ' + q);
      flags.name = true;
      const v = need('str').v.toLowerCase();
      return (n) => n.name.toLowerCase().includes(v);
    }
    if (x.v === 'mimeType') {
      const op = toks[p++];
      if (op && op.t === '=') { const v = need('str').v; return (n) => n.mimeType === v; }
      if (op && op.t === 'word' && op.v === 'contains') { const v = need('str').v; return (n) => n.mimeType.includes(v); }
    }
    throw new Error('Invalid Value: 未対応の q: ' + q);
  }
  function atom() {
    if (peek() && peek().t === '(') { p++; const e = orExpr(); need(')'); return e; }
    return cond();
  }
  function andExpr() {
    const parts = [atom()];
    while (eatWord('and')) parts.push(atom());
    return (n, f) => parts.every((fn) => fn(n, f));
  }
  function orExpr() {
    const parts = [andExpr()];
    while (eatWord('or')) parts.push(andExpr());
    return (n, f) => parts.some((fn) => fn(n, f));
  }
  const test = orExpr();
  if (p !== toks.length) throw new Error('Invalid Value: q の末尾に余り: ' + q);
  return { test, flags };
}

// ---------------------------------------------------------------- UrlFetchApp の応答

export function resp(code, { headers = {}, bytes = Buffer.alloc(0), text = '' } = {}) {
  return {
    getResponseCode: () => code,
    getHeaders: () => headers,
    getContent: () => bytes,
    getContentText: () => text,
  };
}

function toBuffer(b) {
  if (Buffer.isBuffer(b)) return b;
  if (ArrayBuffer.isView(b)) return Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  return Buffer.from(b); // 通常の配列（符号付きバイトでも & 255 で巻き戻る）
}

// ---------------------------------------------------------------- メモリ上の Drive

/**
 * opts:
 *   effective / active        Session のメール（null で空）
 *   driveAppWorks             DriveApp フォールバックが使えるか（既定 true）
 *   overlap                   再開可能アップロードで、受信済みの範囲に重なる PUT の扱い。'reject'（400。厳しい側、既定）/ 'accept'（重なりを無視して続行）
 *   completedPut              完了済みセッションへのデータ PUT の扱い。'404'（既定）/ 'ok'（同じファイルを 200 で返す）
 *   etagHeader                ETag ヘッダの綴り（既定 'ETag'）
 */
export function createFakeDrive(opts = {}) {
  const fake = {
    opts: { effective: USER, active: USER, driveAppWorks: true, overlap: 'reject', completedPut: '404', etagHeader: 'ETag', ...opts },
    rootId: 'FAKEROOTID0123456789',
    nodes: new Map(),
    drives: [],
    sessions: new Map(),
    cache: new Map(),
    cacheTtls: [],
    faults: [],
    fetchLog: [],
    driveAppCalls: [],
    tokenChecks: [],
    seq: 0,
  };
  const now = () => '2026-01-02T03:04:05.000Z';

  // ---- ノードの追加
  fake.addNode = (n) => {
    const node = { modifiedTime: now(), canDownload: true, trashed: false, ...n };
    if (!node.id) node.id = 'FAKENODE' + String(++fake.seq).padStart(12, '0');
    if (node.content) node.etag = '"v' + ++fake.seq + '"';
    fake.nodes.set(node.id, node);
    return node;
  };
  fake.addFolder = (name, parent, extra = {}) =>
    fake.addNode({ name, mimeType: FOLDER_MIME, parents: parent === null ? undefined : [parent === undefined ? fake.rootId : parent], canAddChildren: true, ...extra });
  fake.addFile = (name, mimeType, content, parent, extra = {}) =>
    fake.addNode({ name, mimeType, content: Buffer.isBuffer(content) ? content : Buffer.from(content), parents: [parent === undefined ? fake.rootId : parent], ...extra });
  fake.addSharedDrive = (name, extra = {}) => {
    const id = extra.id || 'FAKESHAREDDRIVE' + String(++fake.seq).padStart(6, '0');
    const d = { id, name, canAddChildren: true, ...extra };
    fake.drives.push(d);
    fake.addNode({ id, name, mimeType: FOLDER_MIME, driveId: id, canAddChildren: d.canAddChildren, isDriveRoot: true });
    return d;
  };
  fake.addRoot = () => fake.addNode({ id: fake.rootId, name: 'My Drive', mimeType: FOLDER_MIME, canAddChildren: true, isMyDriveRoot: true });
  fake.addRoot();
  fake.replaceContent = (id, content) => {
    const n = fake.nodes.get(id);
    n.content = Buffer.isBuffer(content) ? content : Buffer.from(content);
    n.etag = '"v' + ++fake.seq + '"';
    n.modifiedTime = '2026-02-03T04:05:06.000Z';
  };
  fake.filesNamed = (name) => [...fake.nodes.values()].filter((n) => n.name === name);
  /** 新規アップロードで増えたファイル（addNode 済みの初期ノードを除く） */
  fake.uploaded = () => [...fake.nodes.values()].filter((n) => n.uploaded);
  fake.cacheKeys = () => [...fake.cache.keys()];

  const resolve = (id) => fake.nodes.get(id === 'root' ? fake.rootId : id);

  // ---- API のリソース表現（Drive v3 の files リソースを真似る。size は文字列）
  function resource(n) {
    const r = { kind: 'drive#file', id: n.id, name: n.name, mimeType: n.mimeType };
    if (n.parents && n.parents.length) r.parents = [...n.parents];
    if (n.driveId) r.driveId = n.driveId;
    if (n.content) r.size = String(n.content.length);
    r.modifiedTime = n.modifiedTime;
    r.capabilities = { canDownload: n.canDownload !== false, canAddChildren: n.mimeType === FOLDER_MIME && n.canAddChildren === true };
    if (n.shortcutDetails) r.shortcutDetails = { ...n.shortcutDetails };
    if (n.starred) r.starred = true;
    if (n.viewedByMeTime) r.viewedByMeTime = n.viewedByMeTime;
    return r;
  }
  const notFound = (api, id) => new Error(`API call to drive.${api} failed with error: File not found: ${id}.`);

  function paginate(items, args, maxPage) {
    const size = args.pageSize === undefined ? 100 : args.pageSize;
    if (!Number.isInteger(size) || size < 1 || size > maxPage) throw new Error('Invalid Value: pageSize: ' + size);
    let start = 0;
    if (args.pageToken) {
      const m = /^FAKETOKEN-(\d+)$/.exec(args.pageToken);
      if (!m) throw new Error('Invalid Value: pageToken');
      start = Number(m[1]);
    }
    const page = items.slice(start, start + size);
    return { page, next: start + size < items.length ? 'FAKETOKEN-' + (start + size) : undefined };
  }

  const files = {
    get(id, args = {}) {
      const n = resolve(id);
      if (!n) throw notFound('files.get', id);
      return project(resource(n), parseFields(args.fields || 'id,name,mimeType'));
    },
    list(args = {}) {
      if (args.includeItemsFromAllDrives && !args.supportsAllDrives) throw new Error('Invalid Value: includeItemsFromAllDrives には supportsAllDrives が必要');
      const { test, flags } = parseQ(args.q);
      let hits = [...fake.nodes.values()].filter((n) => !n.isDriveRoot && !n.isMyDriveRoot && test(n, fake));
      // 既定の corpora では共有ドライブの中身は名前検索に出ない（allDrives を付けたときだけ出る）
      if (flags.name && !flags.parents && args.corpora !== 'allDrives') hits = hits.filter((n) => !n.driveId);
      if (args.orderBy === 'folder,name') {
        hits.sort((a, b) => ((a.mimeType === FOLDER_MIME ? 0 : 1) - (b.mimeType === FOLDER_MIME ? 0 : 1)) || a.name.localeCompare(b.name));
      } else if (args.orderBy === 'viewedByMeTime desc') {
        hits.sort((a, b) => Date.parse(b.viewedByMeTime) - Date.parse(a.viewedByMeTime));
      } else if (args.orderBy) {
        throw new Error('Invalid Value: orderBy: ' + args.orderBy);
      }
      const { page, next } = paginate(hits, args, 1000);
      const out = { kind: 'drive#fileList', incompleteSearch: false, files: page.map(resource) };
      if (next) out.nextPageToken = next;
      return project(out, parseFields(args.fields || 'nextPageToken,files(id,name,mimeType)'));
    },
    create(res, media, args = {}) {
      if (media) throw new Error('このスタブはフォルダの作成だけを扱う（media あり）');
      if (!res || res.mimeType !== FOLDER_MIME) throw new Error('このスタブはフォルダの作成だけを扱う');
      const parentId = (res.parents && res.parents[0]) || 'root';
      const parent = resolve(parentId);
      if (!parent) throw notFound('files.create', parentId);
      if (parent.mimeType !== FOLDER_MIME) throw new Error('API call to drive.files.create failed with error: 親がフォルダではない');
      if (parent.canAddChildren !== true) throw new Error('API call to drive.files.create failed with error: The user does not have sufficient permissions for this file.');
      const n = fake.addFolder(res.name, parent.id, { driveId: parent.driveId, created: true });
      return project(resource(n), parseFields(args.fields || 'id,name'));
    },
  };
  const drives = {
    list(args = {}) {
      const { page, next } = paginate(fake.drives, args, 100);
      const out = { kind: 'drive#driveList', drives: page.map((d) => ({ kind: 'drive#drive', id: d.id, name: d.name, capabilities: { canAddChildren: d.canAddChildren === true } })) };
      if (next) out.nextPageToken = next;
      return project(out, parseFields(args.fields || 'nextPageToken,drives(id,name)'));
    },
  };

  // ---- UrlFetchApp
  function classify(url, o) {
    const method = String(o.method || 'get').toLowerCase();
    if (url.startsWith('https://www.googleapis.com/drive/v3/files/') && url.includes('alt=media')) return 'download';
    if (url.startsWith(UPLOAD_BASE)) {
      if (!url.includes('upload_id=')) return method === 'post' ? 'upload-begin' : 'unknown';
      if (method === 'delete') return 'upload-delete';
      if (method === 'put') return /^bytes \*\//.test((o.headers || {})['Content-Range'] || '') ? 'upload-status' : 'upload-chunk';
    }
    return 'unknown';
  }
  const hasAuth = (o) => (o.headers || {}).Authorization === 'Bearer ' + SECRET_TOKEN;

  function doDownload(url, o) {
    if (!hasAuth(o)) return resp(401);
    const id = decodeURIComponent(/\/files\/([^?]+)\?/.exec(url)[1]);
    const n = fake.nodes.get(id);
    if (!n) return resp(404);
    if (!n.content || n.canDownload === false) return resp(403, { text: 'downloadRestricted' });
    const size = n.content.length;
    const h = (o.headers || {}).Range;
    if (!h) return resp(200, { headers: { [fake.opts.etagHeader]: n.etag }, bytes: n.content });
    const m = /^bytes=(\d+)-(\d*)$/.exec(h);
    if (!m) return resp(400);
    const a = Number(m[1]);
    const b = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
    if (a >= size) return resp(416, { headers: { 'Content-Range': `bytes */${size}` } });
    return resp(206, { headers: { 'Content-Range': `bytes ${a}-${b}/${size}`, [fake.opts.etagHeader]: n.etag }, bytes: n.content.subarray(a, b + 1) });
  }

  function doBegin(url, o) {
    if (!hasAuth(o)) return resp(401);
    const meta = JSON.parse(String(o.payload || '{}'));
    const h = o.headers || {};
    const total = Number(h['X-Upload-Content-Length']);
    if (!Number.isInteger(total) || total < 1) return resp(400, { text: 'X-Upload-Content-Length' });
    if (!meta.name) return resp(400, { text: 'name' });
    const parentId = (meta.parents && meta.parents[0]) || 'root';
    const parent = resolve(parentId);
    if (!parent) return resp(404, { text: 'File not found' });
    if (parent.mimeType !== FOLDER_MIME) return resp(400, { text: 'parent is not a folder' });
    if (parent.canAddChildren !== true) return resp(403, { text: 'insufficientFilePermissions' });
    const id = 'FAKE-UPLOAD-SESSION-' + String(++fake.seq).padStart(6, '0');
    fake.sessions.set(id, {
      id, name: meta.name, mimeType: meta.mimeType, declaredType: h['X-Upload-Content-Type'], parent: parent.id, driveId: parent.driveId,
      total, buffer: Buffer.alloc(total), received: 0, done: false, cancelled: false, file: null, chunkPuts: 0, statusQueries: 0,
    });
    return resp(200, { headers: { Location: `${UPLOAD_BASE}&supportsAllDrives=true&fields=id%2Cname&upload_id=${id}` } });
  }

  function sessionOf(url) {
    const id = /[?&]upload_id=([^&]+)/.exec(url)[1];
    return fake.sessions.get(id);
  }
  function complete(s) {
    const node = fake.addFile(s.name, s.mimeType, Buffer.from(s.buffer), s.parent, { uploaded: true, driveId: s.driveId });
    s.done = true;
    s.file = { id: node.id, name: node.name };
    return resp(200, { text: JSON.stringify(s.file) });
  }
  const rangeHeader = (s) => (s.received > 0 ? { Range: `bytes=0-${s.received - 1}` } : {});

  function doStatus(url, o) {
    const s = sessionOf(url);
    if (!s || s.cancelled) return resp(404);
    const m = /^bytes \*\/(\d+)$/.exec(o.headers['Content-Range']);
    if (!m || Number(m[1]) !== s.total) return resp(400);
    s.statusQueries++;
    if (s.done) return resp(200, { text: JSON.stringify(s.file) });
    return resp(308, { headers: rangeHeader(s) });
  }

  function doChunk(url, o) {
    const s = sessionOf(url);
    if (!s || s.cancelled) return resp(404);
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(o.headers['Content-Range'] || '');
    if (!m) return resp(400, { text: 'Content-Range' });
    const a = Number(m[1]);
    const b = Number(m[2]);
    const t = Number(m[3]);
    const data = toBuffer(o.payload);
    if (t !== s.total) return resp(400, { text: 'total' });
    if (data.length !== b - a + 1) return resp(400, { text: 'Content-Length と Content-Range が合わない' });
    if (b + 1 < t && data.length % KB256 !== 0) return resp(400, { text: '途中のチャンクが 256 KiB の倍数でない' });
    if (o.contentType && o.contentType !== 'application/octet-stream') return resp(400, { text: 'contentType' });
    if (s.done) return fake.opts.completedPut === 'ok' ? resp(200, { text: JSON.stringify(s.file) }) : resp(404);
    if (a > s.received) return resp(400, { text: 'Content-Range の先頭が受信済みより先' });
    if (a < s.received && fake.opts.overlap !== 'accept') return resp(400, { text: 'Content-Range の先頭が受信済みより前（重なり）' });
    s.chunkPuts++;
    if (b + 1 > s.received) {
      data.copy(s.buffer, a);
      s.received = b + 1;
    }
    if (s.received === s.total) return complete(s);
    return resp(308, { headers: rangeHeader(s) });
  }

  function doDelete(url) {
    const s = sessionOf(url);
    if (!s) return resp(404);
    s.cancelled = true;
    s.buffer = null; // 未完成の中身は捨てられる
    return resp(499);
  }

  /**
   * 故障の注入。fake.faults.push({ kind, times = 1, skip = 0, status, throwBefore, throwAfter, afterStore, when })
   *   kind: 'download' | 'upload-begin' | 'upload-status' | 'upload-chunk' | 'upload-delete'
   *   status: 処理せずにこのコードを返す。afterStore: true なら、処理（保存）してから status を返す / throwAfter なら保存してから例外
   *   throwBefore: 処理せずに例外（通信エラー） / skip: 最初の skip 回は素通り
   */
  function takeFault(kind, url, o) {
    for (const f of fake.faults) {
      if (f.kind !== kind || (f.times ?? 1) <= 0) continue;
      if (f.when && !f.when(url, o)) continue;
      if ((f.skip || 0) > 0) { f.skip--; continue; }
      f.times = (f.times ?? 1) - 1;
      f.hits = (f.hits || 0) + 1;
      return f;
    }
    return null;
  }

  const fetch = (url, o = {}) => {
    const kind = classify(url, o);
    fake.fetchLog.push({ kind, url, method: String(o.method || 'get').toLowerCase(), range: (o.headers || {}).Range, contentRange: (o.headers || {})['Content-Range'], bytes: kind === 'upload-chunk' ? toBuffer(o.payload).length : 0 });
    if (kind === 'unknown') throw new Error('想定外の UrlFetchApp.fetch: ' + url);
    const fault = takeFault(kind, url, o);
    if (fault && fault.throwBefore) throw new Error('Exception: Timeout: ' + url.split('?')[0]);
    let r;
    if (fault && fault.status !== undefined && !fault.afterStore) {
      r = resp(fault.status, { text: 'injected' });
    } else {
      r = kind === 'download' ? doDownload(url, o)
        : kind === 'upload-begin' ? doBegin(url, o)
          : kind === 'upload-status' ? doStatus(url, o)
            : kind === 'upload-chunk' ? doChunk(url, o)
              : doDelete(url, o);
      if (fault && fault.throwAfter) throw new Error('Exception: Timeout: ' + url.split('?')[0]);
      if (fault && fault.afterStore) r = resp(fault.status ?? 500, { text: 'injected' });
    }
    const code = r.getResponseCode();
    // 実際の UrlFetchApp の挙動: muteHttpExceptions なしで 4xx / 5xx は例外。308 は followRedirects:false でないと追従を試みて失敗する
    if (code >= 400 && o.muteHttpExceptions !== true) throw new Error(`Request failed for ${url.split('?')[0]} returned code ${code}`);
    if (code === 308 && o.followRedirects !== false) throw new Error('308 を追従しようとした（followRedirects:false が必要）');
    return r;
  };

  // ---- 他の GAS サービス
  const email = (v) => ({ getEmail: () => (v === null ? '' : v) });
  const userCache = {
    get: (k) => (fake.cache.has(k) ? fake.cache.get(k) : null),
    put: (k, v, ttl) => {
      if (String(k).length > 250) throw new Error('Exception: Argument too large: key');
      if (String(v).length > 100 * 1024) throw new Error('Exception: Argument too large: value');
      if (ttl !== undefined && (!(ttl >= 1) || ttl > 21600)) throw new Error('Exception: 有効期間が範囲外: ' + ttl);
      fake.cacheTtls.push([k, ttl]);
      fake.cache.set(k, String(v));
    },
    remove: (k) => { fake.cache.delete(k); },
  };

  fake.globals = () => ({
    Session: {
      getEffectiveUser: () => email(fake.opts.effective),
      getActiveUser: () => email(fake.opts.active),
    },
    HtmlService: { XFrameOptionsMode: { DEFAULT: 1 } },
    console: { error() {}, log() {} },
    Utilities: {
      base64Encode: (b) => toBuffer(b).toString('base64'),
      base64Decode: (s) => Buffer.from(String(s), 'base64'),
      getUuid: () => crypto.randomUUID(),
    },
    CacheService: { getUserCache: () => userCache },
    ScriptApp: { getOAuthToken: () => SECRET_TOKEN },
    Drive: { Files: files, Drives: drives },
    UrlFetchApp: { fetch },
    DriveApp: {
      getFileById: (id) => {
        fake.driveAppCalls.push(id); // DriveApp フォールバック（ファイル全体の読み込み）に入った回数の検査用
        if (!fake.opts.driveAppWorks) throw new Error('Exception: Service unavailable: DriveApp');
        const n = fake.nodes.get(id);
        if (!n || !n.content) throw new Error('Exception: No item with the given ID could be found.');
        return {
          getSize: () => n.content.length,
          getBlob: () => {
            if (n.canDownload === false) throw new Error('Exception: You do not have permission to download this file');
            return { getBytes: () => n.content };
          },
        };
      },
    },
  });
  return fake;
}

// ---------------------------------------------------------------- Code.gs を読み込むサーバー

/**
 * opts: driveEnabled（既定 true）、chunkUnits（サーバーの既定チャンクを 256 KiB × n にする。小さいデータで複数チャンクを試すため）
 * 戻り値: { newContext(), call(name, ...args) }（call は生の戻り値）
 */
export function createServer(fake, { driveEnabled = true, chunkUnits = null } = {}) {
  let code = bakeCodeGs(SOURCE, { driveEnabled });
  if (chunkUnits !== null) {
    const patched = code.replace('var DRIVE_CHUNK_BYTES_ = 32 * DRIVE_ALIGN_;', `var DRIVE_CHUNK_BYTES_ = ${chunkUnits} * DRIVE_ALIGN_;`);
    if (patched === code) throw new Error('DRIVE_CHUNK_BYTES_ の定義行が見つからない（Code.gs の書式が変わった）');
    code = patched;
  }
  const script = new vm.Script(code, { filename: 'Code.gs' });
  const newContext = () => {
    const ctx = vm.createContext(fake.globals());
    script.runInContext(ctx);
    return ctx;
  };
  return { newContext, call: (name, ...args) => newContext()[name](...args) };
}

/** 標準の Drive の中身（フォルダ数個・音声・入れ子・共有ドライブ・共有アイテム・スター付き・ショートカットなど）。 */
export function seedStandardDrive(fake) {
  const ids = {};
  const R = fake.rootId;
  const mk = (key, node) => { ids[key] = node.id; return node; };
  mk('music', fake.addNode({ id: 'FAKEFOLDER-MUSIC-0001', name: '音楽', mimeType: FOLDER_MIME, parents: [R], canAddChildren: true }));
  mk('work', fake.addNode({ id: 'FAKEFOLDER-WORK-0001', name: '仕事', mimeType: FOLDER_MIME, parents: [R], canAddChildren: true }));
  mk('work2026', fake.addNode({ id: 'FAKEFOLDER-WORK-2026', name: '2026', mimeType: FOLDER_MIME, parents: [ids.work], canAddChildren: true }));
  mk('readonly', fake.addNode({ id: 'FAKEFOLDER-READONLY-1', name: '閲覧専用', mimeType: FOLDER_MIME, parents: [R], canAddChildren: false }));
  mk('rec', fake.addFile('rec-a.m4a', 'audio/mp4', 'AAAA-rec-a', R, { id: 'FAKEFILE-REC-A-0001' }));
  mk('memo', fake.addFile('memo.mp3', 'audio/mpeg', 'memo-bytes', R, { id: 'FAKEFILE-MEMO-0001' }));
  mk('octet', fake.addFile('octet.m4a', 'application/octet-stream', 'octet-m4a-bytes', R, { id: 'FAKEFILE-OCTET-0001' }));
  mk('video', fake.addFile('clip.mp4', 'video/mp4', 'video-bytes', R, { id: 'FAKEFILE-VIDEO-0001' }));
  mk('locked', fake.addFile('locked.mp3', 'audio/mpeg', 'locked-bytes', R, { id: 'FAKEFILE-LOCKED-0001', canDownload: false }));
  mk('empty', fake.addFile('empty.mp3', 'audio/mpeg', '', R, { id: 'FAKEFILE-EMPTY-0001' }));
  mk('pdf', fake.addFile('doc.pdf', 'application/pdf', 'pdf', R, { id: 'FAKEFILE-PDF-00001' }));
  mk('octetTxt', fake.addFile('data.txt', 'application/octet-stream', 'txt', R, { id: 'FAKEFILE-OCTETTXT-1' }));
  mk('gdoc', fake.addNode({ id: 'FAKEFILE-GDOC-00001', name: 'メモ', mimeType: 'application/vnd.google-apps.document', parents: [R] }));
  mk('nested', fake.addFile('nested.wav', 'audio/wav', 'wav-bytes', ids.work2026, { id: 'FAKEFILE-NESTED-0001' }));
  mk('star', fake.addFile('star.mp3', 'audio/mpeg', 'star-bytes', ids.music, { id: 'FAKEFILE-STAR-00001', starred: true }));
  mk('viewed', fake.addFile('viewed.mp3', 'audio/mpeg', 'viewed-bytes', ids.music, { id: 'FAKEFILE-VIEWED-001', viewedByMeTime: '2026-03-01T00:00:00.000Z' }));
  mk('viewed2', fake.addFile('viewed2.mp3', 'audio/mpeg', 'viewed2-bytes', ids.music, { id: 'FAKEFILE-VIEWED-002', viewedByMeTime: '2026-04-01T00:00:00.000Z' }));
  // 共有アイテム（親はたどれない）
  mk('sharedFile', fake.addNode({ id: 'FAKEFILE-SHARED-001', name: '共有された.mp3', mimeType: 'audio/mpeg', content: Buffer.from('shared'), sharedWithMe: true }));
  mk('sharedFolder', fake.addNode({ id: 'FAKEFOLDER-SHARED-01', name: '共有されたフォルダ', mimeType: FOLDER_MIME, sharedWithMe: true, canAddChildren: false }));
  mk('sharedInner', fake.addFile('共有フォルダ内.m4a', 'audio/mp4', 'inner', ids.sharedFolder, { id: 'FAKEFILE-SHAREDIN-01' }));
  // 共有ドライブ
  const sd = fake.addSharedDrive('共有ドライブ甲', { id: 'FAKESHAREDDRIVE000001' });
  ids.sharedDrive = sd.id;
  mk('sdFolder', fake.addNode({ id: 'FAKEFOLDER-SD-0001', name: '会議', mimeType: FOLDER_MIME, parents: [sd.id], driveId: sd.id, canAddChildren: true }));
  mk('sdFile', fake.addFile('会議.m4a', 'audio/mp4', 'sd-audio', ids.sdFolder, { id: 'FAKEFILE-SD-000001', driveId: sd.id }));
  const sd2 = fake.addSharedDrive('共有ドライブ乙', { id: 'FAKESHAREDDRIVE000002', canAddChildren: false });
  ids.sharedDrive2 = sd2.id;
  // ショートカット
  const sc = (key, id, name, target, tmime) => mk(key, fake.addNode({ id, name, mimeType: SHORTCUT_MIME, parents: [R], shortcutDetails: { targetId: target, targetMimeType: tmime } }));
  sc('scFolder', 'FAKESHORTCUT-FOLDER-1', '仕事への近道', ids.work, FOLDER_MIME);
  sc('scAudio', 'FAKESHORTCUT-AUDIO-01', '録音への近道.m4a', ids.rec, 'audio/mp4');
  sc('scPdf', 'FAKESHORTCUT-PDF-0001', 'PDF への近道', ids.pdf, 'application/pdf');
  sc('scShortcut', 'FAKESHORTCUT-SC-00001', '近道への近道', 'FAKESHORTCUT-AUDIO-01', SHORTCUT_MIME);
  return ids;
}

/** 疑似乱数（再現可能）のバイト列 */
export function randomBytes(n, seed = 1) {
  const out = Buffer.allocUnsafe(n);
  let x = (seed >>> 0) || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    out[i] = x & 255;
  }
  return out;
}
