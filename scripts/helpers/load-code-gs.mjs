// gas/Code.gs を node:vm で読み込み、GAS のサービスを模擬する（redirect.test.mjs / icon.test.mjs で共用）。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { bakeCodeGs } from '../bundle-gas.mjs';

const GAS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'gas');
const read = (n) => fs.readFileSync(path.join(GAS_DIR, n), 'utf8');

/** env: { prop, baked, icon, iconProp, throwsProps, throwsIconProps, faviconThrows } */
export function load(env = {}) {
  const calls = { file: [], html: [], favicon: [], scriptApp: 0, errors: [] };
  const makeOut = (kind) => {
    const o = {
      kind,
      title: null,
      setTitle(t) { o.title = t; return o; },
      addMetaTag() { return o; },
      setXFrameOptionsMode() { return o; },
      setFaviconUrl(u) { if (env.faviconThrows) throw new Error('bad favicon'); calls.favicon.push(u); return o; },
    };
    return o;
  };
  const ctx = vm.createContext({
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => {
          if (env.throwsProps) throw new Error('props');
          if (k === 'AUDIO_SPLITTER_ICON_URL') {
            if (env.throwsIconProps) throw new Error('props');
            return env.iconProp !== undefined ? env.iconProp : null;
          }
          return k === 'AUDIO_SPLITTER_REDIRECT_URL' && env.prop !== undefined ? env.prop : null;
        },
      }),
    },
    ScriptApp: { getService: () => { calls.scriptApp++; throw new Error('getUrl は呼ばない'); } },
    HtmlService: {
      XFrameOptionsMode: { DEFAULT: 1 },
      createHtmlOutput(html) { calls.html.push(html); const o = makeOut('string'); o.html = html; return o; },
      createHtmlOutputFromFile(name) { calls.file.push(name); return makeOut('file'); },
    },
    console: { error(...a) { calls.errors.push(a.join(' ')); } },
  });
  const code = bakeCodeGs(read('Code.gs'), { iconUrl: env.icon ?? '', redirectUrl: env.baked ?? '' });
  vm.runInContext(code, ctx, { filename: 'Code.gs' });
  return { ctx, calls };
}
