/**
 * Chunk a scheme document into semantic pieces the verifier can feed to
 * an LLM without blowing past the context window (or the wallet).
 *
 * Most Indian schemes on myScheme are short — their eligibility blob is
 * a few hundred characters and doesn't need chunking. But some ministry
 * schemes carry multi-page eligibility text plus long benefits and
 * document lists, and passing all of that as a single blob:
 *   - inflates token cost every single verification call
 *   - forces the model to answer about the whole thing at once, which
 *     bleeds context between unrelated criteria
 *
 * The chunker splits the raw text at sentence boundaries into
 * ~CHUNK_SIZE-character pieces with a small overlap so no criterion
 * gets torn across a boundary, then tags each chunk with which "section"
 * of the scheme it came from (description / eligibility / benefits /
 * documents). Section tags make the verifier's prompt more precise:
 * "check the eligibility chunks against the user's profile fields", not
 * "read this pile of text and figure it out".
 */

const CHUNK_SIZE = 600;      // characters per chunk — small enough to be cheap, big enough to hold a full criterion sentence
const CHUNK_OVERLAP = 80;    // overlap so a sentence split near a boundary is still resolvable

function splitSentences(text) {
  if (!text) return [];
  // Split on ".", "!", "?", newlines, and bulleted list markers. Keep the
  // separators inside the sentence so the reconstructed chunk still reads
  // like natural text.
  return text
    .replace(/\r\n/g, "\n")
    .split(/(?<=[.!?])\s+|\n+|(?=^\s*[-•*]\s+)/m)
    .map((s) => s.trim())
    .filter(Boolean);
}

function packChunks(sentences, section) {
  const chunks = [];
  let current = "";
  for (const s of sentences) {
    if (current.length === 0) {
      current = s;
    } else if (current.length + 1 + s.length <= CHUNK_SIZE) {
      current += " " + s;
    } else {
      chunks.push({ section, text: current });
      // seed the next chunk with the tail of the current one so no
      // requirement that spans a boundary loses its subject.
      const tail = current.slice(Math.max(0, current.length - CHUNK_OVERLAP));
      current = (tail + " " + s).trim();
    }
  }
  if (current) chunks.push({ section, text: current });
  return chunks;
}

/**
 * Build a chunk list for one scheme. Sections that are empty are
 * skipped entirely — no point wasting an LLM call on "documents: (none)".
 */
function chunkScheme(scheme) {
  const sections = [
    { section: "name",        text: scheme.name || "" },
    { section: "description", text: scheme.description || "" },
    { section: "eligibility", text: scheme.eligibility || "" },
    { section: "benefits",    text: scheme.benefits || "" },
    { section: "documents",   text: Array.isArray(scheme.documents) ? scheme.documents.join("; ") : (scheme.documents || "") },
    { section: "ministry",    text: scheme.ministry ? `Ministry: ${scheme.ministry}` : "" },
    { section: "state",       text: scheme.state ? `State: ${scheme.state}` : "" },
  ].filter((s) => s.text && s.text.trim().length > 0);

  const out = [];
  for (const { section, text } of sections) {
    const sents = splitSentences(text);
    if (sents.length === 0) continue;
    // Very short sections stay whole — no need to chunk a 40-char string.
    if (text.length <= CHUNK_SIZE) {
      out.push({ section, text });
    } else {
      out.push(...packChunks(sents, section));
    }
  }
  return out;
}

/**
 * Return a compact ranked list of chunks most likely to contain
 * eligibility-relevant content for THIS user. We don't have embeddings
 * available (no vector store here — this is a rules pipeline first), so
 * ranking is a cheap keyword-overlap score against the user's profile:
 * how many profile terms show up in the chunk. Ties broken by section
 * priority (eligibility > description > benefits > everything else).
 *
 * This keeps token cost bounded regardless of how long the scheme is:
 * the LLM sees the top-K most relevant chunks, not the whole document.
 */
const SECTION_PRIORITY = { eligibility: 4, description: 3, name: 3, ministry: 2, state: 2, benefits: 1, documents: 1 };

function userKeywords(user) {
  const p = user?.profile || {};
  const kws = new Set();
  const add = (v) => { if (v) String(v).toLowerCase().split(/[\s,\/]+/).filter(Boolean).forEach((w) => kws.add(w)); };
  add(p.state); add(p.gender); add(p.occupation); add(p.education);
  (p.categories || []).forEach(add);
  (p.documentsAvailable || []).forEach(add);
  if (Number.isFinite(p.age)) kws.add(String(p.age));
  return [...kws];
}

function rankChunksForUser(chunks, user, topK = 8) {
  const kws = userKeywords(user);
  const scored = chunks.map((c) => {
    const lower = c.text.toLowerCase();
    const overlap = kws.reduce((n, k) => n + (lower.includes(k) ? 1 : 0), 0);
    return { ...c, score: overlap + (SECTION_PRIORITY[c.section] || 0) * 0.1 };
  });
  scored.sort((a, b) => b.score - a.score);
  // Always include at least one eligibility chunk if one exists — the
  // verifier can't do its job without eligibility text in front of it.
  const eligChunks = chunks.filter((c) => c.section === "eligibility");
  const picked = scored.slice(0, topK);
  for (const ec of eligChunks) {
    if (!picked.includes(ec)) picked.push(ec);
  }
  return picked.slice(0, Math.max(topK, eligChunks.length + 2));
}

module.exports = { chunkScheme, rankChunksForUser, splitSentences, CHUNK_SIZE, CHUNK_OVERLAP };
