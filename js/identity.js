// ── identity.js — random human-readable identities + color assignment ────
export const Identity = (() => {
  const ADJECTIVES = [
    'amber','cobalt','crimson','cyan','dusk','ember','frost','iron','jade',
    'lapis','mist','onyx','pearl','rose','rust','sage','slate','storm',
    'teal','violet','zinc','azure','coral','golden','silver','chalk',
    'bronze','scarlet','indigo','ochre',
  ];
  const NOUNS = [
    'anchor','arrow','atlas','axiom','beacon','bridge','cipher','delta',
    'echo','falcon','flare','forge','gate','helix','keystone','lantern',
    'nexus','orbit','prism','relay','signal','tower','vector','vertex',
    'zenith','ridge','canal','passage','reach','haven',
  ];
  const PALETTE = [
    '#f97316','#3b82f6','#22c55e','#ec4899','#a855f7',
    '#10b981','#f59e0b','#d946ef','#06b6d4','#eab308',
  ];
  const CANAL_WORDS = [
    ...ADJECTIVES.slice(0, 15),
    'river','valley','ridge','peak','basin','delta','coast','dune','crest',
    'mesa','pass','reach','sound','strait','inlet',
  ];

  function generate() {
    const a = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
    const n = NOUNS[Math.floor(Math.random() * NOUNS.length)];
    return `${a}-${n}`;
  }

  function generateCanal() {
    const w1 = CANAL_WORDS[Math.floor(Math.random() * CANAL_WORDS.length)];
    const w2 = CANAL_WORDS[Math.floor(Math.random() * CANAL_WORDS.length)];
    const n  = Math.floor(Math.random() * 90) + 10;
    return `${w1}-${w2}-${n}`;
  }

  function colorFor(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
    return PALETTE[h % PALETTE.length];
  }

  function initials(name) {
    const parts = name.split('-');
    return (parts[0][0] + (parts[1]?.[0] ?? '')).toUpperCase();
  }

  return { generate, generateCanal, colorFor, initials };
})();
