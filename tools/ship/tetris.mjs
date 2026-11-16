// Tetris whose screen is the text of a post.
//
// Emoji share one advance, so each line of the board is a true grid; ⬛ is an
// empty cell. A side panel (NEXT, SCORE, LINES, LEVEL) follows the board on the
// same lines: text after the last cell cannot move the cells before it. Every
// tick of `simulate()` is one frame. The bag is seeded, so every run plays the
// same game.

const W = 10;
const H = 18;
const EMPTY = "⬛";
const FLASH = "⬜";

const SHAPES = {
  I: { e: "🟦", m: [[1, 1, 1, 1]] },
  O: { e: "🟨", m: [[1, 1], [1, 1]] },
  T: { e: "🟪", m: [[1, 1, 1], [0, 1, 0]] },
  S: { e: "🟩", m: [[0, 1, 1], [1, 1, 0]] },
  Z: { e: "🟥", m: [[1, 1, 0], [0, 1, 1]] },
  J: { e: "🟫", m: [[1, 0, 0], [1, 1, 1]] },
  L: { e: "🟧", m: [[0, 0, 1], [1, 1, 1]] },
};

const rotate = (m) => m[0].map((_, c) => m.map((row) => row[c]).reverse());
const ROTATIONS = Object.fromEntries(
  Object.entries(SHAPES).map(([k, { m }]) => {
    const out = [m];
    for (let i = 0; i < 3; i++) {
      const next = rotate(out[out.length - 1]);
      if (!out.some((r) => JSON.stringify(r) === JSON.stringify(next))) out.push(next);
    }
    return [k, out];
  }),
);

function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cellsOf = (m, x, y) => m.flatMap((row, r) => row.flatMap((v, c) => (v ? [[x + c, y + r]] : [])));
const fits = (board, m, x, y) => cellsOf(m, x, y).every(([cx, cy]) => cx >= 0 && cx < W && cy < H && (cy < 0 || !board[cy][cx]));

/** Heights, holes, bumpiness and full rows: the classic placement heuristic. */
function evaluate(board) {
  const heights = Array(W).fill(0);
  let holes = 0;
  for (let x = 0; x < W; x++) {
    let seen = false;
    for (let y = 0; y < H; y++) {
      if (board[y][x]) {
        if (!seen) heights[x] = H - y;
        seen = true;
      } else if (seen) holes++;
    }
  }
  const lines = board.filter((row) => row.every(Boolean)).length;
  const aggregate = heights.reduce((a, b) => a + b, 0);
  let bump = 0;
  for (let x = 0; x < W - 1; x++) bump += Math.abs(heights[x] - heights[x + 1]);
  return -0.510066 * aggregate + 0.760666 * lines - 0.35663 * holes - 0.184483 * bump;
}

function bestPlacement(board, type) {
  let best = null;
  ROTATIONS[type].forEach((m, rot) => {
    for (let x = -1; x <= W - m[0].length + 1; x++) {
      if (!fits(board, m, x, 0)) continue;
      let y = 0;
      while (fits(board, m, x, y + 1)) y++;
      const trial = board.map((row) => [...row]);
      for (const [cx, cy] of cellsOf(m, x, y)) trial[cy][cx] = type;
      const score = evaluate(trial);
      if (!best || score > best.score) best = { rot, x, score };
    }
  });
  return best;
}

/**
 * Plays a short game and returns every frame. It ends on the first line clear
 * after `minPieces` pieces, so the last thing on screen is rows collapsing.
 */
export function simulate({ minPieces = 22, maxPieces = 40 } = {}) {
  const rand = mulberry32(2006);
  const board = Array.from({ length: H }, () => Array(W).fill(null));
  let bag = [];
  const draw7 = () => {
    if (!bag.length) {
      bag = Object.keys(SHAPES);
      for (let i = bag.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [bag[i], bag[j]] = [bag[j], bag[i]];
      }
    }
    return bag.pop();
  };
  let next = draw7();
  let piece = null;
  let score = 0;
  let lines = 0;
  let placed = 0;
  let flash = null; // { rows, ttl }
  const frames = [];
  const level = () => 1 + Math.floor(lines / 4);

  const draw = (tick) => {
    const g = board.map((row) => row.map((t) => (t ? SHAPES[t].e : EMPTY)));
    if (flash) for (const y of flash.rows) g[y].fill(FLASH);
    if (piece) {
      for (const [cx, cy] of cellsOf(ROTATIONS[piece.type][piece.rot], piece.x, piece.y)) {
        if (cy >= 0) g[cy][cx] = SHAPES[piece.type].e;
      }
    }
    // The NEXT preview: the piece in its spawn rotation, in a 4×2 box.
    const preview = Array.from({ length: 2 }, () => Array(4).fill(EMPTY));
    const m = SHAPES[next].m;
    for (const [cx, cy] of cellsOf(m, Math.floor((4 - m[0].length) / 2), 0)) preview[cy][cx] = SHAPES[next].e;
    const panel = {
      1: "NEXT",
      2: preview[0].join(""),
      3: preview[1].join(""),
      5: "SCORE",
      6: String(score),
      8: "LINES",
      9: String(lines),
      11: "LEVEL",
      12: String(level()),
    };
    const text = g.map((row, y) => (panel[y] ? `${row.join("")}\u3000${panel[y]}` : row.join(""))).join("\n");
    frames.push({ tick, score, lines, placed, level: level(), text });
  };

  let tick = 0;
  for (; tick < 1000; tick++) {
    if (flash) {
      flash.ttl--;
      if (flash.ttl <= 0) {
        for (const y of flash.rows) {
          board.splice(y, 1);
          board.unshift(Array(W).fill(null));
        }
        flash = null;
        if (placed >= minPieces) {
          draw(tick);
          tick++;
          break;
        }
      }
      draw(tick);
      continue;
    }
    if (!piece) {
      if (placed >= maxPieces) break;
      const type = next;
      next = draw7();
      const m = ROTATIONS[type][0];
      piece = { type, rot: 0, x: Math.floor((W - m[0].length) / 2), y: 0, target: bestPlacement(board, type) };
      if (!piece.target || !fits(board, m, piece.x, 0)) break; // topped out
      draw(tick);
      continue;
    }
    // Rotate, then slide toward the chosen column, one visible step a frame,
    // falling a row each frame; once lined up, drop fast.
    const t = piece.target;
    const rots = ROTATIONS[piece.type];
    if (piece.rot !== t.rot && fits(board, rots[t.rot], piece.x, piece.y)) {
      piece.rot = t.rot;
    } else if (piece.x !== t.x && fits(board, rots[piece.rot], piece.x + Math.sign(t.x - piece.x), piece.y)) {
      piece.x += Math.sign(t.x - piece.x);
    }
    const aligned = piece.rot === t.rot && piece.x === t.x;
    const fall = aligned ? Math.min(4, 2 + Math.floor(lines / 4)) : 1;
    let locked = false;
    for (let k = 0; k < fall; k++) {
      if (fits(board, rots[piece.rot], piece.x, piece.y + 1)) piece.y++;
      else {
        locked = true;
        break;
      }
    }
    if (locked) {
      for (const [cx, cy] of cellsOf(rots[piece.rot], piece.x, piece.y)) if (cy >= 0) board[cy][cx] = piece.type;
      piece = null;
      placed++;
      const full = board.flatMap((row, y) => (row.every(Boolean) ? [y] : []));
      if (full.length) {
        lines += full.length;
        score += [0, 100, 300, 500, 800][full.length] * level();
        flash = { rows: full, ttl: 3 };
      }
    }
    draw(tick);
  }
  for (let k = 0; k < 14; k++) draw(tick + k);
  return { frames, stats: { score, lines, placed, ticks: tick } };
}
