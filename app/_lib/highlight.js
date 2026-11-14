// A small syntax highlighter for the code on this page: JavaScript and
// TypeScript, Rust, shell and TOML. One left-to-right regex pass; each token
// becomes a <span class="t-…">.

const KEYWORDS = {
  js: "import|from|export|const|let|var|await|async|function|return|new|if|else|for|of|in|throw|try|catch|type|interface|true|false|null|undefined",
  rust: "use|let|mut|fn|pub|struct|impl|match|if|else|return|async|await|dyn|Box|true|false|Some|None|Ok|Err",
  sh: "npm|cargo|echo|xeet",
  toml: "true|false",
};

const COMMENT = {
  js: String.raw`\/\/[^\n]*|\/\*[\s\S]*?\*\/`,
  rust: String.raw`\/\/[^\n]*|\/\*[\s\S]*?\*\/`,
  sh: String.raw`#[^\n]*`,
  toml: String.raw`#[^\n]*`,
};

function tokenizer(lang) {
  const parts = [`(?<comment>${COMMENT[lang] ?? COMMENT.js})`];
  // Rust raw strings first, so the quotes inside them are not tokens.
  if (lang === "rust") parts.push(String.raw`(?<string1>r#"[\s\S]*?"#)`);
  parts.push(String.raw`(?<string>"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\x60(?:\\.|[^\x60\\])*\x60)`);
  if (lang === "sh") {
    // A command is the first word of a line or of a pipeline stage; the word
    // after it is its subcommand. Anywhere else (a URL, a file name) the same
    // letters are plain text.
    parts.push(
      String.raw`(?<keyword1>(?<=^|\|\s*)(?:${KEYWORDS.sh})\b)`,
      String.raw`(?<fn1>(?<=(?:^|\|\s*)(?:xeet|npm|cargo)\s)[a-z]+\b)`,
      String.raw`(?<prop2>(?<![\w-])--?[a-zA-Z][\w-]*)`,
      String.raw`(?<number1>(?<![\w/.:-])\d+(?![\w/.-]))`,
      String.raw`(?<plain>[^\s,|]+)`,
    );
  }
  if (lang === "toml") parts.push(String.raw`(?<type1>^\[[^\]\n]+\])`, String.raw`(?<prop1>\b[\w-]+(?=\s*=))`);
  if (lang !== "sh") {
    parts.push(
      String.raw`(?<keyword>\b(?:${KEYWORDS[lang] ?? KEYWORDS.js})\b)`,
      String.raw`(?<number>\b\d+(?:\.\d+)?\b)`,
    );
  }
  if (lang !== "sh" && lang !== "toml") {
    parts.push(
      String.raw`(?<fn>\b[A-Za-z_]\w*(?=\s*[(!]))`,
      String.raw`(?<prop>\b[A-Za-z_]\w*(?=\s*:(?!:)))`,
      String.raw`(?<type>\b[A-Z]\w*\b)`,
    );
  }
  parts.push(String.raw`(?<punct>[{}()[\];,.=<>&|?!:+\-*/]+)`);
  return new RegExp(parts.join("|"), "gm");
}

const escape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function highlight(code, lang = "js") {
  let out = "";
  let last = 0;
  for (const match of code.matchAll(tokenizer(lang))) {
    out += escape(code.slice(last, match.index));
    // Group names carry a digit when a kind appears twice (`string1`); the
    // class is the kind alone.
    const kind = Object.entries(match.groups).find(([, v]) => v !== undefined)?.[0].replace(/\d+$/, "");
    out += `<span class="t-${kind}">${escape(match[0])}</span>`;
    last = match.index + match[0].length;
  }
  return out + escape(code.slice(last));
}

/** Highlights every `<pre><code data-lang>` under `root`, in place. */
export function highlightAll(root = document) {
  for (const el of root.querySelectorAll("pre code[data-lang]")) {
    el.innerHTML = highlight(el.textContent, el.dataset.lang);
  }
}
