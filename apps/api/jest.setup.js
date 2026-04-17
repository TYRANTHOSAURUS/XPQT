// Provide a jsdom window/document for DOMPurify (browser build) in Node test env.
// isomorphic-dompurify is mapped to its browser dist via moduleNameMapper, so
// DOMPurify looks for window.document on load. We create it here.
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!DOCTYPE html>');
global.window = dom.window;
global.document = dom.window.document;
