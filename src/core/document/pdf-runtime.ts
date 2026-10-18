import {existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';

export function pdfRuntimeOptions() {
  const bundled=join(dirname(fileURLToPath(import.meta.url)),'pdfjs');
  const root=existsSync(join(bundled,'cmaps','GBK-EUC-H.bcmap'))?bundled:dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
  const directory=(name:string)=>join(root,name).replace(/\\/g,'/')+'/';
  return {cMapUrl:directory('cmaps'),cMapPacked:true,standardFontDataUrl:directory('standard_fonts'),wasmUrl:directory('wasm')};
}
