// Deliberately supports only headings and plain paragraphs. Policy text cannot
// introduce executable HTML, remote assets or a dependency on dashboard login.
export function privacyPage(markdown) {
  const escape = (text) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  const body = markdown.trim().split(/\r?\n\s*\r?\n/).map((block) => {
    const heading = /^(#{1,2}) (.+)$/.exec(block);
    return heading ? `<h${heading[1].length}>${escape(heading[2])}</h${heading[1].length}>` : `<p>${escape(block.replace(/\r?\n/g, " "))}</p>`;
  }).join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Prosegate privacy</title><link rel="stylesheet" href="/assets/app.css"></head><body><main class="setup"><a href="/">Prosegate dashboard</a>${body}</main></body></html>\n`;
}
