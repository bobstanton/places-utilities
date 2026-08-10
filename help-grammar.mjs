/**
 * Highlight grammar for Places code blocks, consumed by
 * md-to-obsidian-dom's --grammar option. Display-fence examples in help
 * pages are tokenized at build time and emitted as static token spans, so
 * the plugin registers nothing with Prism at runtime. Editor highlighting
 * is separate and richer; this grammar only needs to make static help
 * examples readable.
 */
export function covers(language) {
  return language.startsWith('places');
}

export const grammar = {
  'comment': /#.*/,
  'delimiter': /^---$/m,
  'keyword': {
    pattern: /(^[\t ]*(?:-\s*)?)[a-zA-Z][a-zA-Z0-9_-]*(?=\s*:)/m,
    lookbehind: true,
    greedy: true
  },
  'string': [
    /"(?:[^"\\]|\\.)*"/,
    /'(?:[^'\\]|\\.)*'/,
    // Single-line scalar values after colon. Block-valued keys like
    // `directions:` and `routes:` must not consume their nested lines.
    {
      pattern: /(:[\t ]*)[^\n#]+/,
      lookbehind: true,
      greedy: true,
      inside: {
        'number': /\b\d+(\.\d+)?(%|px|vh|vw|em|rem)?\b/i,
        'boolean': /\b(true|false)\b/i,
        'url': /https?:\/\/[^\s]+/i,
        // SQL/Dataview keywords (must use word boundaries to avoid matching within words)
        'keyword': /\b(?:SELECT|FROM|WHERE|JOIN|LEFT|RIGHT|INNER|OUTER|ON|AND|OR|NOT|IN|IS|NULL|AS|ORDER|BY|GROUP|HAVING|LIMIT|OFFSET|ASC|DESC|DISTINCT|UNION|ALL|SORT|FLATTEN|TABLE|LIST|TASK|CALENDAR)\b/i
      }
    }
  ],
  'number': /\b\d+(\.\d+)?(%|px|vh|vw|em|rem)?\b/i,
  'punctuation': /[:|.-]/,
  // Use word boundaries for AND/OR to avoid matching within words like "favorite", "transform"
  'operator': /[><=!]+|\bAND\b|\bOR\b/i
};
