// src/lib/driveTypes.ts の型を、実行時に検査できる関数にしたもの（JSON 往復後の値を検査する）。
// 各関数はエラー文字列の配列を返す（空なら型どおり）。キーの有無・型・null を許すフィールド・余計なキー・undefined を見る。

const isStr = (v) => typeof v === 'string';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isBool = (v) => typeof v === 'boolean';
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const strOrNull = (v) => v === null || isStr(v);
const numOrNull = (v) => v === null || isNum(v);
const lit = (x) => (v) => v === x;
const oneOf = (...xs) => (v) => xs.includes(v);

/** spec: { required: { key: pred }, optional: { key: pred } }。余計なキーはエラー。 */
export function check(x, spec, path = '$') {
  const errs = [];
  if (!isObj(x)) return [`${path}: オブジェクトではない (${JSON.stringify(x)})`];
  const req = spec.required || {};
  const opt = spec.optional || {};
  for (const [k, pred] of Object.entries(req)) {
    if (!(k in x)) errs.push(`${path}.${k}: キーが無い`);
    else if (!pred(x[k])) errs.push(`${path}.${k}: 型が違う (${JSON.stringify(x[k])})`);
  }
  for (const k of Object.keys(x)) {
    if (x[k] === undefined) errs.push(`${path}.${k}: undefined`);
    if (!(k in req) && !(k in opt)) errs.push(`${path}.${k}: 型に無い余計なキー`);
    else if (k in opt && !(k in req) && !opt[k](x[k])) errs.push(`${path}.${k}: 型が違う (${JSON.stringify(x[k])})`);
  }
  return errs;
}

export const isGasErrorShape = (x, path = '$') =>
  check(x, { required: { error: (v) => isStr(v) && v.length > 0 }, optional: { retryable: lit(true), code: isStr } }, path);

export function driveItem(x, path = '$') {
  const errs = check(x, {
    required: { id: isStr, name: isStr, type: oneOf('file', 'folder'), mimeType: isStr, size: numOrNull, updated: numOrNull, canDownload: isBool },
    optional: { canAddChildren: isBool, shortcut: lit(true), driveId: isStr },
  }, path);
  if (isObj(x)) {
    if (x.id === '') errs.push(`${path}.id: 空`);
    if (x.type === 'folder') {
      if (typeof x.canAddChildren !== 'boolean') errs.push(`${path}: フォルダなのに canAddChildren が無い`);
      if (x.size !== null) errs.push(`${path}: フォルダの size は null`);
    }
    if (x.type === 'file' && 'canAddChildren' in x) errs.push(`${path}: ファイルに canAddChildren がある`);
  }
  return errs;
}

export const driveFolder = (x, path = '$') =>
  check(x, { required: { id: isStr, name: isStr, parentId: strOrNull, isRoot: isBool, driveId: strOrNull, canAddChildren: isBool } }, path);

const arrayOf = (items, fn, path) => {
  if (!Array.isArray(items)) return [`${path}: 配列ではない`];
  return items.flatMap((it, i) => fn(it, `${path}[${i}]`));
};

export function listFolderResult(x, path = '$') {
  const errs = check(x, { required: { folder: isObj, items: Array.isArray }, optional: { truncated: isBool } }, path);
  if (isObj(x)) {
    errs.push(...driveFolder(x.folder, `${path}.folder`));
    errs.push(...arrayOf(x.items, driveItem, `${path}.items`));
  }
  return errs;
}

export const folderPathResult = (x, path = '$') => [
  ...check(x, { required: { path: Array.isArray } }, path),
  ...(isObj(x) ? arrayOf(x.path, (e, p) => check(e, { required: { id: isStr, name: isStr } }, p), `${path}.path`) : []),
];

export function searchResult(x, path = '$') {
  const errs = check(x, { required: { query: isStr, items: Array.isArray, truncated: isBool } }, path);
  if (isObj(x)) errs.push(...arrayOf(x.items, driveItem, `${path}.items`));
  return errs;
}

export function resolveResult(x, path = '$') {
  if (!isObj(x)) return [`${path}: オブジェクトではない`];
  if (x.kind === 'folder') return check(x, { required: { kind: lit('folder'), id: isStr, name: isStr } }, path);
  if (x.kind === 'file') {
    return [...check(x, { required: { kind: lit('file'), item: isObj, parentId: strOrNull } }, path), ...driveItem(x.item, `${path}.item`)];
  }
  return [`${path}.kind: folder / file ではない (${JSON.stringify(x.kind)})`];
}

export const createFolderResult = (x, path = '$') => check(x, { required: { success: lit(true), id: isStr, name: isStr } }, path);
export const fileInfoResult = (x, path = '$') =>
  check(x, { required: { success: lit(true), id: isStr, name: isStr, size: isNum, mimeType: isStr, updated: numOrNull, parentId: strOrNull, chunkSize: isNum } }, path);
export const fileChunkResult = (x, path = '$') =>
  check(x, { required: { success: lit(true), offset: isNum, length: isNum, data: isStr, etag: strOrNull, partial: isBool } }, path);
export const beginUploadResult = (x, path = '$') => check(x, { required: { success: lit(true), token: isStr, chunkSize: isNum } }, path);
export function uploadChunkResult(x, path = '$') {
  if (isObj(x) && x.done === true) {
    return [...check(x, { required: { success: lit(true), done: lit(true), next: isNum, file: isObj } }, path), ...check(x.file, { required: { id: isStr, name: isStr } }, `${path}.file`)];
  }
  return check(x, { required: { success: lit(true), done: lit(false), next: isNum } }, path);
}
export const abortUploadResult = (x, path = '$') => check(x, { required: { success: lit(true) } }, path);
export const driveStatus = (x, path = '$') =>
  isObj(x) && x.enabled === false
    ? check(x, { required: { enabled: lit(false), reason: isStr } }, path)
    : check(x, { required: { enabled: lit(true) } }, path);
