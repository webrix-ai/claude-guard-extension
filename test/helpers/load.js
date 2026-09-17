'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/**
 * Evaluate a browser script inside a jsdom window's global scope.
 */
function evalInWindow(window, rel) {
  window.eval(read(rel));
}

/**
 * Create a jsdom window that looks like a page a content script would run in.
 * Node's fetch primitives are exposed so interceptor.js can construct Responses.
 */
function createPage({ url = 'https://app.example.com/dashboard', html = '<!doctype html><html><head><title>Page</title></head><body></body></html>', silent = true } = {}) {
  const virtualConsole = new VirtualConsole();
  if (!silent) virtualConsole.sendTo(console);
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  const { window } = dom;
  window.Headers = Headers;
  window.Request = Request;
  window.Response = Response;
  return dom;
}

/**
 * Run background.js in a fresh VM context wired to a chrome mock.
 */
function loadBackground(chrome) {
  const context = vm.createContext({
    chrome,
    URL,
    console,
    setTimeout,
    clearTimeout,
    Date
  });
  vm.runInContext(read('background.js'), context, { filename: 'background.js' });
  return context;
}

/** Flush microtasks and one macrotask tick (jsdom postMessage is async). */
function tick(ms = 0) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { ROOT, read, evalInWindow, createPage, loadBackground, tick };
