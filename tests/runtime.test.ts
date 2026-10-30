import { expect, test } from "bun:test";
import { changedChunkLoader } from "../src/runtime";

test("unchanged loaders and unrelated u properties do not imply missing chunks", () => {
  const loader = 'runtime.u=chunk=>"/static/"+chunk+".js";';
  expect(changedChunkLoader(loader + "const feature=1;", loader + "const feature=2;")).toBe(false);
  expect(changedChunkLoader("module.u=1;", "module.u=2;")).toBe(false);
  expect(changedChunkLoader("runtime.u=()=>environment.loadWebAssemblyModule('old.wasm');", "runtime.u=()=>environment.loadWebAssemblyModule('new.wasm');")).toBe(false);
});

test("changed loader maps include nested expressions and referenced definitions", () => {
  const source = (digest: string) => `runtime.u=chunk=>{if(chunk===1){return '/static/'+({1:'${digest}'})[chunk]+'.js'}return chunk+'.js'};`;
  expect(changedChunkLoader(source("before"), source("after"))).toBe(true);
  const external = (digest: string) => `const chunks={1:'${digest}'};runtime.u=chunk=>'/static/'+chunks[chunk]+'.js';`;
  expect(changedChunkLoader(external("before"), external("after"))).toBe(true);
  const helper = (digest: string) => `function chunkName(id){return '${digest}'+id;}runtime.u=id=>chunkName(id)+'.js';`;
  expect(changedChunkLoader(helper("before"), helper("after"))).toBe(true);
  const mutation = (digest: string) => `const chunks={};chunks[1]='${digest}';runtime.u=id=>chunks[id]+'.js';`;
  expect(changedChunkLoader(mutation("before"), mutation("after"))).toBe(true);
  expect(changedChunkLoader("", source("new"))).toBe(true);
  expect(changedChunkLoader(source("old"), "")).toBe(true);
});

test("comments and whitespace do not change loader definitions", () => {
  expect(changedChunkLoader('runtime.u=chunk=>chunk+".js";', 'runtime.u = chunk => /* same */ chunk + ".js";')).toBe(false);
});

test("shadowed maps and property names do not contaminate loader dependencies", () => {
  const source = (digest: string) => `const chunks={1:'stable'}; runtime.u=chunk=>chunks[chunk]+'.js'; function unrelated(){const chunks={1:'${digest}'}; return chunks;}`;
  expect(changedChunkLoader(source("before"), source("after"))).toBe(false);
  const parameter = (digest: string) => `const chunk='${digest}'; runtime.u=chunk=>chunk+'.js';`;
  expect(changedChunkLoader(parameter("before"), parameter("after"))).toBe(false);
  const property = (digest: string) => `const id='${digest}'; runtime.u=chunk=>chunk.id+'.js';`;
  expect(changedChunkLoader(property("before"), property("after"))).toBe(false);
  const runtimeProperty = (digest: string) => `function runtime(){}runtime.p='/static/';runtime.h='${digest}';runtime.u=chunk=>runtime.p+chunk+'.js';`;
  expect(changedChunkLoader(runtimeProperty("before"), runtimeProperty("after"))).toBe(false);
  const publicPath = (path: string) => `function runtime(){}runtime.p='${path}';runtime.u=chunk=>runtime.p+chunk+'.js';`;
  expect(changedChunkLoader(publicPath("/old/"), publicPath("/new/"))).toBe(true);
});

test("unparseable runtime code is not silently treated as complete", () => {
  expect(() => changedChunkLoader("runtime.u=???", "")).toThrow();
});
