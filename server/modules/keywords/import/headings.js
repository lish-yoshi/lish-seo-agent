/**
 * HTML から H2 / H3 を抽出する（T-07）
 *
 * HTML パーサーの依存を足さず、WordPress の content.rendered を対象に正規表現で抜く。
 * ブロックエディタが出力する見出しは構造が単純なので、これで足りる。
 *   - 先に HTML コメント・<script>・<style>・<noscript> を除去（その中の偽の見出しを拾わない）
 *   - 見出しの内側のタグは除去し、エンティティを復号、空白を 1 つに畳む
 */

const NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/**
 * HTML エンティティを復号する。
 * 名前付きは amp / lt / gt / quot / apos / nbsp、数値参照は 10 進・16 進（&#8217; &#038; &#x2019; など）。
 * 1 回の置換で処理するため、&amp;lt; が < まで二重に復号されることはない。
 */
function decodeEntities(text) {
  return String(text ?? "").replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch (_) {
        return match;
      }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named !== undefined ? named : match;
  });
}

function stripNonContent(html) {
  return String(html ?? "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript\s*>/gi, " ");
}

/** タグ除去 → エンティティ復号 → 空白の正規化（nbsp を含む） */
function cleanText(innerHtml) {
  return decodeEntities(String(innerHtml ?? "").replace(/<[^>]*>/g, ""))
    .replace(/[\s ]+/g, " ")
    .trim();
}

/** [{ level: 2|3, text }] を文書順で返す。空の見出しは捨てる */
function extractHeadings(html) {
  const source = stripNonContent(html);
  const out = [];
  const re = /<h([23])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi;
  let m;
  while ((m = re.exec(source)) !== null) {
    const text = cleanText(m[2]);
    if (text) out.push({ level: Number(m[1]), text });
  }
  return out;
}

module.exports = { extractHeadings, decodeEntities, cleanText };
