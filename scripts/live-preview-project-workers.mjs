import { parse } from "@babel/parser";

// Keep Vite's native Worker(new URL(..., import.meta.url)) syntax visible so it
// still bundles and checks the project worker graph. Only authored constructors
// receive the opaque-origin Blob bootstrap; the global Worker stays untouched.
export function bindLiveProjectWorkers(code) {
  if (!code.includes("Worker") || !code.includes("import.meta")) return;
  const ast = parse(code, { sourceType: "module", plugins: ["typescript", "jsx"] });
  const edits = [];
  let binding = "__frameLiveProjectWorker";
  while (code.includes(binding)) binding += "_";
  const walk = node => {
    if (!node || typeof node !== "object") return;
    const url = node.type === "NewExpression" && node.callee?.type === "Identifier" && node.callee.name === "Worker" && node.arguments[0];
    const meta = url?.type === "NewExpression" && url.callee?.type === "Identifier" && url.callee.name === "URL" && url.arguments[1];
    if (url?.arguments?.[0]?.type === "StringLiteral" && meta?.type === "MemberExpression" && meta.property?.name === "url" &&
        meta.object?.type === "MetaProperty" && meta.object.meta?.name === "import" && meta.object.property?.name === "meta") {
      edits.push({ start: node.start, end: node.end, replacement: "((Worker)=>" + code.slice(node.start, node.end) + ")(" + binding + ")" });
      return;
    }
    for (const value of Object.values(node))
      if (Array.isArray(value)) value.forEach(walk); else if (value && typeof value === "object") walk(value);
  };
  walk(ast.program);
  if (!edits.length) return;
  for (const edit of edits.sort((a, b) => b.start - a.start)) code = code.slice(0, edit.start) + edit.replacement + code.slice(edit.end);
  return { code: "import {createPreviewWorker as " + binding + "} from 'frame-live-assets';" + code, map: null };
}

export const previewWorkerRuntime = `export function createPreviewWorker(url,options){
  const cached=globalThis.__FRAME_PREVIEW_WORKER__?.(url,options);if(cached)return cached;
  if(options?.type==='module')throw Error("Opaque live preview supports classic bundled workers; omit type:'module'.");
  const href=new URL(String(url),globalThis.location.href).href;
  const base=new URL('../',href).href;
  const prefix='self.__FRAME_LIVE_ASSET_BASE__='+JSON.stringify(base)+';';
  const source=prefix+'importScripts('+JSON.stringify(href)+');';
  const blob=URL.createObjectURL(new Blob([source],{type:'application/javascript'}));
  try{
    const worker=new Worker(blob,options),terminate=worker.terminate.bind(worker);
    let released=false;
    const release=()=>{if(!released){released=true;URL.revokeObjectURL(blob);}};
    worker.terminate=()=>{release();terminate();};
    worker.addEventListener('error',release,{once:true});
    return worker;
  }catch(error){URL.revokeObjectURL(blob);throw error;}
}`;
