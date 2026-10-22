const { Module } = require('node:module');
const path = require('node:path');
const ts = require('typescript');
require('reflect-metadata');
require('tsx/cjs');

exports.createSourceLoader = (source, entry) => {
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
      esModuleInterop: true,
    },
    fileName: entry,
  }).outputText;
  return () => {
    const instance = new Module(entry);
    instance.filename = entry;
    instance.paths = Module._nodeModulePaths(path.dirname(entry));
    instance._compile(compiled, entry);
    return instance.exports;
  };
};
