import assert from 'node:assert/strict';
import { test } from 'node:test';
import { baseOf, decodeHtml, headStart, pagePolicy, preparePage } from '../src/htmlPage';

const SOURCE = 'https://*.vscode-resource.vscode-cdn.net';
const FOLDER = 'https://file+.vscode-resource.vscode-cdn.net/Users/me/site/';
const frame = { policy: pagePolicy(SOURCE, true), folder: FOLDER, source: SOURCE };

const latin1 = (text: string) => Buffer.from(text, 'latin1');

// ---- Encoding -----------------------------------------------------------------------------------------------

test('a byte order mark decides the encoding, whatever the head declares', () => {
  const text = '<meta charset="windows-1251"><p>Grüße, мир</p>';
  assert.equal(decodeHtml(Buffer.concat([Buffer.of(0xef, 0xbb, 0xbf), Buffer.from(text)])), text);
  assert.equal(decodeHtml(Buffer.concat([Buffer.of(0xff, 0xfe), Buffer.from(text, 'utf16le')])), text);
  assert.equal(decodeHtml(Buffer.concat([Buffer.of(0xfe, 0xff), Buffer.from(text, 'utf16le').swap16()])), text);
});

test('the charset of the head is used, in both ways of declaring it', () => {
  const cyrillic = Buffer.of(0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2); // "Привет" in Windows-1251
  for (const meta of [
    '<meta charset="windows-1251">',
    "<meta charset='WINDOWS-1251'>",
    '<meta charset=windows-1251>',
    '<META http-equiv="Content-Type" content="text/html; charset=windows-1251">',
  ]) {
    assert.equal(decodeHtml(Buffer.concat([latin1(`<html><head>${meta}</head><body>`), cyrillic])), `<html><head>${meta}</head><body>Привет`, meta);
  }
});

test('a declaration inside a comment is none', () => {
  const bytes = Buffer.concat([latin1('<!-- <meta charset="windows-1251"> --><p>'), Buffer.from('Привет')]);
  assert.equal(decodeHtml(bytes), '<!-- <meta charset="windows-1251"> --><p>Привет');
});

test('a declaration past the first 1024 bytes comes too late', () => {
  const bytes = Buffer.concat([latin1(`<!--${' '.repeat(1100)}--><meta charset="windows-1251"><p>`), Buffer.from('Привет')]);
  assert.ok(decodeHtml(bytes).endsWith('<p>Привет'));
});

test('without a declaration the text is UTF-8, and Windows-1252 when it is not valid UTF-8', () => {
  assert.equal(decodeHtml(Buffer.from('<p>Grüße — мир</p>')), '<p>Grüße — мир</p>');
  assert.equal(decodeHtml(Buffer.of(0x3c, 0x70, 0x3e, 0x80, 0x20, 0x93, 0xfc, 0x94)), '<p>€ “ü”');
});

test('declared UTF-8 with stray bytes keeps what is readable', () => {
  const bytes = Buffer.concat([latin1('<meta charset="utf-8"><p>'), Buffer.from('é'), Buffer.of(0xff), latin1('</p>')]);
  assert.equal(decodeHtml(bytes), '<meta charset="utf-8"><p>é�</p>');
});

test('a declared UTF-16 without a byte order mark, and a name no decoder knows, are passed over', () => {
  assert.equal(decodeHtml(Buffer.from('<meta charset="utf-16"><p>é</p>')), '<meta charset="utf-16"><p>é</p>');
  assert.equal(decodeHtml(Buffer.from('<meta charset="klingon"><p>é</p>')), '<meta charset="klingon"><p>é</p>');
});

test('an empty file is an empty text', () => {
  assert.equal(decodeHtml(new Uint8Array(0)), '');
});

// ---- Where the head begins ----------------------------------------------------------------------------------

/** The text with a mark where the head would be written. */
const marked = (html: string) => `${html.slice(0, headStart(html))}^${html.slice(headStart(html))}`;

test('the head starts behind the doctype, <html> and <head>, as far as they are there', () => {
  assert.equal(marked('<!DOCTYPE html><html lang="en"><head><title>x</title></head>'), '<!DOCTYPE html><html lang="en"><head>^<title>x</title></head>');
  assert.equal(marked('<!doctype html>\n<html>\n  <head>\n    <meta charset="utf-8">'), '<!doctype html>\n<html>\n  <head>^\n    <meta charset="utf-8">');
  assert.equal(marked('<!DOCTYPE html>\n<title>x</title><p>text'), '<!DOCTYPE html>\n^<title>x</title><p>text');
  assert.equal(marked('<html><body><p>text'), '<html>^<body><p>text');
  assert.equal(marked('<p>just text'), '^<p>just text');
  assert.equal(marked(''), '^');
});

test('comments and blank space in front are stepped over', () => {
  assert.equal(marked('﻿\n<!-- saved from url=(0014)about:internet -->\n<!DOCTYPE html>\n<!-- a > b -->\n<html>\n<head>\n<title>'), '﻿\n<!-- saved from url=(0014)about:internet -->\n<!DOCTYPE html>\n<!-- a > b -->\n<html>\n<head>^\n<title>');
});

test('a > inside a quoted attribute does not end the tag', () => {
  assert.equal(marked('<html data-a="1 > 0" data-b=\'>\'><head data-c=">">x'), '<html data-a="1 > 0" data-b=\'>\'><head data-c=">">^x');
});

test('a tag that only begins like <head> or <html> is content', () => {
  assert.equal(marked('<!DOCTYPE html><header>top</header>'), '<!DOCTYPE html>^<header>top</header>');
  assert.equal(marked('<html-import href="x"></html-import>'), '^<html-import href="x"></html-import>');
  assert.equal(marked('<html><heading>'), '<html>^<heading>');
});

test('a tag that is never closed is left where it is', () => {
  assert.equal(marked('<!DOCTYPE html><html lang="en'), '<!DOCTYPE html>^<html lang="en');
});

// ---- The base -----------------------------------------------------------------------------------------------

test('without a <base> relative addresses lead to the folder of the file', () => {
  assert.equal(baseOf('<head><link href="a.css"></head>', FOLDER), FOLDER);
});

test('a <base> of the page is resolved against the folder', () => {
  assert.equal(baseOf('<head><base href="assets/"></head>', FOLDER), `${FOLDER}assets/`);
  assert.equal(baseOf('<head><BASE target="_blank" HREF=\'../shared/\'></head>', FOLDER), 'https://file+.vscode-resource.vscode-cdn.net/Users/me/shared/');
  assert.equal(baseOf('<base href=https://example.com/app/>', FOLDER), 'https://example.com/app/');
  assert.equal(baseOf('<base href="/">', FOLDER), 'https://file+.vscode-resource.vscode-cdn.net/');
});

test('the first <base> with an address counts', () => {
  assert.equal(baseOf('<base target="_top"><base href="one/"><base href="two/">', FOLDER), `${FOLDER}one/`);
});

test('a <base> in a comment, in the content or in another attribute is none', () => {
  assert.equal(baseOf('<head><!-- <base href="old/"> --></head>', FOLDER), FOLDER);
  assert.equal(baseOf('<head></head><body><pre>&lt;base&gt;</pre><base href="late/">', FOLDER), FOLDER);
  assert.equal(baseOf('<head><meta content=\'<base href="quoted/">\'><basefont href="x/"></head>', FOLDER), FOLDER);
  assert.equal(baseOf('<head><base data-href="x/" title="href=y/"></head>', FOLDER), FOLDER);
  assert.equal(baseOf('<head><script>document.write(\'<base href="written/">\')</script><style>/* <base href="styled/"> */</style></head>', FOLDER), FOLDER);
  assert.equal(baseOf('<head><title><base href="titled/"></title><base href="real/"></head>', FOLDER), `${FOLDER}real/`);
  assert.equal(baseOf('<head><script>never closed <base href="x/">', FOLDER), FOLDER);
});

test('an address that can not be resolved leaves the folder', () => {
  assert.equal(baseOf('<base href="https://exa mple.com:99999/">', FOLDER), FOLDER);
});

// ---- The policy ---------------------------------------------------------------------------------------------

test('scripts are allowed or shut out as a whole, and the rest of the page loads either way', () => {
  const on = pagePolicy(SOURCE, true);
  const off = pagePolicy(SOURCE, false);
  assert.ok(!on.includes('script-src'));
  assert.ok(on.includes("'unsafe-eval'"));
  assert.ok(off.split('; ').includes("script-src 'none'"));
  assert.ok(!off.includes("'unsafe-eval'"));
  for (const policy of [on, off]) {
    const fallback = policy.split('; ')[0];
    assert.ok(fallback.startsWith(`default-src ${SOURCE} https: http: data: blob: 'unsafe-inline'`), policy);
  }
});

// ---- The page as written ------------------------------------------------------------------------------------

test('the policy and the base are the first things in the head, in that order', () => {
  const page = preparePage('<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8">\n<link rel="stylesheet" href="a.css">\n</head>\n<body></body>\n</html>', frame);
  const expected = `<!DOCTYPE html>\n<html>\n<head><meta http-equiv="Content-Security-Policy" content="${frame.policy}"><base href="${FOLDER}">\n<meta charset="utf-8">`;
  assert.ok(page.startsWith(expected), page);
  assert.ok(page.endsWith('<link rel="stylesheet" href="a.css">\n</head>\n<body></body>\n</html>'));
});

test('nothing is put in front of the doctype, and everything else of the file is kept as it is', () => {
  const html = '<!-- note -->\n<!DOCTYPE html>\n<title>t</title>\n<p onclick="a(\'<meta>\')">text &amp; more</p>\n';
  const page = preparePage(html, frame);
  const added = page.length - html.length;
  const at = html.indexOf('<title>');
  assert.equal(page.slice(0, at), html.slice(0, at));
  assert.equal(page.slice(at + added), html.slice(at));
});

test('the base of the page itself goes into the one that is written first', () => {
  const page = preparePage('<head><base href="dist/"><script src="app.js"></script></head>', frame);
  assert.ok(page.includes(`"><base href="${FOLDER}dist/"><base href="dist/">`), page);
});

test('quotes and ampersands in an address do not end the attribute', () => {
  const page = preparePage('<p>', { ...frame, folder: 'https://host/a"b&c/' });
  assert.ok(page.includes('<base href="https://host/a&quot;b&amp;c/">'), page);
});

test("a policy of the page's own gets the folder named beside 'self'", () => {
  const page = preparePage(
    `<head><meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data:; script-src 'none'"><meta name="description" content="'self'"></head><p>'self'</p>`,
    frame,
  );
  assert.ok(page.includes(`content="default-src 'self' ${SOURCE}; img-src 'self' ${SOURCE} data:; script-src 'none'"`), page);
  assert.ok(page.endsWith(`<meta name="description" content="'self'"></head><p>'self'</p>`), page);
});

test('the policy that is written in is not the one that gets rewritten', () => {
  const policy = "default-src 'self'";
  const page = preparePage('<head></head>', { ...frame, policy });
  assert.ok(page.includes(`<meta http-equiv="Content-Security-Policy" content="default-src 'self'">`), page);
});

test('an empty file still gets its head', () => {
  assert.equal(preparePage('', frame), `<meta http-equiv="Content-Security-Policy" content="${frame.policy}"><base href="${FOLDER}">`);
});
