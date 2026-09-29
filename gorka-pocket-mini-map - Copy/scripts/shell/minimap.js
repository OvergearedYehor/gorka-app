const MAP_SIZE = 7;
const CENTER = Math.floor(MAP_SIZE / 2);

const TOKEN_KIND_LABEL = {
  player: "POCKET5E.Movement.MapPlayer",
  friendly: "POCKET5E.Movement.MapFriendly",
  neutral: "POCKET5E.Movement.MapNeutral",
  hostile: "POCKET5E.Movement.MapHostile",
  other: "POCKET5E.Movement.MapOther"
};

function collectionValues(collection) {
  if ( Array.isArray(collection) ) return collection;
  if ( collection?.contents ) return collection.contents;
  return Array.from(collection ?? []);
}

function ownedByUser(actor, user) {
  return user?.isGM === true
    || (typeof actor?.testUserPermission === "function" && actor.testUserPermission(user, "OWNER"));
}

function tokenKind(token, actor) {
  switch ( Number(token.disposition ?? actor?.prototypeToken?.disposition) ) {
    case 1: return "friendly";
    case 0: return "neutral";
    case -1: return "hostile";
    default: return "other";
  }
}

function tokenImage(token, actor) {
  const src = token?.texture?.src ?? token?.img ?? actor?.img ?? "";
  return typeof src === "string" ? src : "";
}

/**
 * Where the scene artwork sits on the same grid the tokens already use. Foundry draws the background in the
 * padded scene rectangle (`dimensions.sceneX/Y` + `sceneWidth/Height`); without those, it is the raw width/height.
 */
function sceneBackdrop(scene, gridSize, gridColumns, gridRows) {
  const src = scene?.background?.src ?? scene?.img ?? "";
  if ( typeof src !== "string" || !src ) return null;
  const sceneX = Number(scene.dimensions?.sceneX);
  const sceneY = Number(scene.dimensions?.sceneY);
  const sceneW = Number(scene.dimensions?.sceneWidth ?? scene.width);
  const sceneH = Number(scene.dimensions?.sceneHeight ?? scene.height);
  const hasOrigin = Number.isFinite(sceneX) && Number.isFinite(sceneY);
  return {
    src,
    x: hasOrigin ? sceneX / gridSize : 0,
    y: hasOrigin ? sceneY / gridSize : 0,
    cols: Number.isFinite(sceneW) && sceneW > 0 ? sceneW / gridSize : gridColumns,
    rows: Number.isFinite(sceneH) && sceneH > 0 ? sceneH / gridSize : gridRows
  };
}

// Foundry wall.door: 0 none, 1 door, 2 secret door. wall.ds: 0 closed, 1 open, 2 locked.
// Edge kinds are ranked so that, when several walls share an edge, the most blocking kind is drawn.
const EDGE_RANK = { open: 1, "secret-open": 1, window: 1.5, wall: 2, closed: 3, locked: 4 };

// CONST.WALL_SENSE_TYPES: PROXIMITY = 30, DISTANCE = 40. Foundry's window walls use these on light/sight.
function isWindowWall(wall) {
  return [wall.light, wall.sight].some(value => [30, 40].includes(Number(value)));
}

function wallEdgeKind(wall, isGM) {
  const door = Number(wall.door ?? 0);
  if ( !door ) return isWindowWall(wall) ? "window" : "wall";
  // A secret door the GM has opened is revealed to everyone; otherwise players see an ordinary wall.
  if ( door === 2 && Number(wall.ds ?? 0) === 1 ) return "secret-open";
  if ( door === 2 && !isGM ) return isWindowWall(wall) ? "window" : "wall";
  switch ( Number(wall.ds ?? 0) ) {
    case 1: return "open";
    case 2: return "locked";
    default: return "closed";
  }
}

function addDiagonalWall(coordinates, gridSize, addVertical, addHorizontal) {
  const [x1, y1, x2, y2] = coordinates;
  const dx = x2 - x1;
  const dy = y2 - y1;
  if ( !dx || !dy ) return;

  let column = Math.floor(x1 / gridSize);
  let row = Math.floor(y1 / gridSize);
  const endColumn = Math.floor(x2 / gridSize);
  const endRow = Math.floor(y2 / gridSize);
  const stepX = Math.sign(dx);
  const stepY = Math.sign(dy);
  const deltaX = gridSize / Math.abs(dx);
  const deltaY = gridSize / Math.abs(dy);
  const boundaryX = stepX > 0 ? (column + 1) * gridSize : column * gridSize;
  const boundaryY = stepY > 0 ? (row + 1) * gridSize : row * gridSize;
  let crossingX = (boundaryX - x1) / dx;
  let crossingY = (boundaryY - y1) / dy;
  const maxSteps = Math.abs(endColumn - column) + Math.abs(endRow - row) + 2;
  let steps = 0;

  while ( (column !== endColumn || row !== endRow) && steps++ < maxSteps ) {
    if ( Math.abs(crossingX - crossingY) < 1e-10 ) {
      addVertical(stepX > 0 ? column + 1 : column, row);
      addHorizontal(column, stepY > 0 ? row + 1 : row);
      column += stepX;
      row += stepY;
      crossingX += deltaX;
      crossingY += deltaY;
    }
    else if ( crossingX < crossingY ) {
      addVertical(stepX > 0 ? column + 1 : column, row);
      column += stepX;
      crossingX += deltaX;
    }
    else {
      addHorizontal(column, stepY > 0 ? row + 1 : row);
      row += stepY;
      crossingY += deltaY;
    }
  }
}

function tokenGridPosition(token, gridSize) {
  const x = Number(token.x);
  const y = Number(token.y);
  if ( !Number.isFinite(x) || !Number.isFinite(y) ) return null;
  const width = Number(token.width);
  const height = Number(token.height);
  return {
    x: Math.floor((x + (Number.isFinite(width) ? width * gridSize / 2 : 0)) / gridSize),
    y: Math.floor((y + (Number.isFinite(height) ? height * gridSize / 2 : 0)) / gridSize)
  };
}

/**
 * Grid footprint of a token: its size in cells and the top-left cell it covers, derived from the cell under its
 * centre so it matches the centre-based positioning used everywhere else. Sizes below one cell count as one.
 */
function tokenFootprint(token, centre) {
  const w = Math.max(1, Math.round(Number(token.width) || 1));
  const h = Math.max(1, Math.round(Number(token.height) || 1));
  return { w, h, x0: centre.x - Math.floor(w / 2), y0: centre.y - Math.floor(h / 2), large: w > 1 || h > 1 };
}

function coversCell(token, x, y) {
  return x >= token.x0 && x < token.x0 + token.w && y >= token.y0 && y < token.y0 + token.h;
}

/**
 * Where a large token's outline is anchored inside the seven-cell window: the first visible cell of its footprint,
 * plus how many cells of it are cut off on the top/left (the frame clips whatever sticks out).
 */
function windowPlacement(token, originX, originY) {
  const left = token.x0 - originX;
  const top = token.y0 - originY;
  if ( left > MAP_SIZE - 1 || top > MAP_SIZE - 1 || left + token.w - 1 < 0 || top + token.h - 1 < 0 ) return null;
  return { column: Math.max(left, 0), row: Math.max(top, 0), dx: Math.max(-left, 0), dy: Math.max(-top, 0) };
}

// When non-player creatures share a cell, the most threatening kind gives the cell its colour and its big dot.
const STACK_PRIORITY = { hostile: 0, neutral: 1, other: 2, friendly: 3 };
const MAX_BADGE_SLOTS = 2;

function stackRank(token) {
  return STACK_PRIORITY[token.kind] ?? STACK_PRIORITY.other;
}

/** The creature that gives a shared cell its colour: lowest rank wins, earlier tokens win ties. */
function stackLead(tokens) {
  return tokens.reduce((lead, token) => (!lead || stackRank(token) < stackRank(lead) ? token : lead), null);
}

function makeWallEdges(scene, gridSize, columns, rows, isGM=false) {
  const edges = new Map();
  let kind = "wall";
  const put = key => {
    if ( (EDGE_RANK[edges.get(key)] ?? 0) < EDGE_RANK[kind] ) edges.set(key, kind);
  };
  const addVertical = (boundary, row) => {
    if ( boundary < 0 || boundary > columns || row < 0 || row >= rows ) return;
    put(`v:${boundary}:${row}`);
  };
  const addHorizontal = (column, boundary) => {
    if ( column < 0 || column >= columns || boundary < 0 || boundary > rows ) return;
    put(`h:${column}:${boundary}`);
  };

  for ( const wall of collectionValues(scene.walls) ) {
    if ( wall.hidden === true ) continue;
    kind = wallEdgeKind(wall, isGM);
    const coordinates = Array.from(wall.c ?? [], Number);
    if ( coordinates.length < 4 || coordinates.slice(0, 4).some(value => !Number.isFinite(value)) ) continue;
    const [x1, y1, x2, y2] = coordinates;
    const tolerance = Math.min(2, gridSize * 0.05);
    if ( Math.abs(x2 - x1) <= tolerance ) {
      const boundary = Math.round(((x1 + x2) / 2) / gridSize);
      const firstRow = Math.floor(Math.min(y1, y2) / gridSize);
      const lastRow = Math.ceil(Math.max(y1, y2) / gridSize) - 1;
      for ( let row = firstRow; row <= lastRow; row++ ) addVertical(boundary, row);
    }
    else if ( Math.abs(y2 - y1) <= tolerance ) {
      const boundary = Math.round(((y1 + y2) / 2) / gridSize);
      const firstColumn = Math.floor(Math.min(x1, x2) / gridSize);
      const lastColumn = Math.ceil(Math.max(x1, x2) / gridSize) - 1;
      for ( let column = firstColumn; column <= lastColumn; column++ ) addHorizontal(column, boundary);
    }
    else addDiagonalWall([x1, y1, x2, y2], gridSize, addVertical, addHorizontal);
  }
  return edges;
}

function localize(key) {
  return globalThis.game?.i18n?.localize(key) ?? key;
}

function edgeKind(map, x, y, side) {
  if ( side === "left" ) return map.wallEdges.get(`v:${x}:${y}`);
  if ( side === "right" ) return map.wallEdges.get(`v:${x + 1}:${y}`);
  if ( side === "top" ) return map.wallEdges.get(`h:${x}:${y}`);
  return map.wallEdges.get(`h:${x}:${y + 1}`);
}

function hasWall(map, x, y, side) {
  return edgeKind(map, x, y, side) === "wall";
}

/** Door state of a cell side ("open", "closed", "locked"), or null when the side has no door. */
function doorState(map, x, y, side) {
  const kind = edgeKind(map, x, y, side);
  return kind && kind !== "wall" && kind !== "window" ? kind : null;
}

function hasWindow(map, x, y, side) {
  return edgeKind(map, x, y, side) === "window";
}

function minimapDebugEnabled() {
  return new URLSearchParams(globalThis.location?.search ?? "").get("minimapDebug") === "1";
}

/**
 * Map the seven-cell window from the real token world position and scene documents.
 * The character is always at row/column four (zero-based index three); the map never moves any document.
 */
export function buildMovementMapWindow(map) {
  if ( !map.available || !map.player ) return [];
  const originX = map.player.x - CENTER;
  const originY = map.player.y - CENTER;
  return Array.from({ length: MAP_SIZE }, (_, rowIndex) => ({
    cells: Array.from({ length: MAP_SIZE }, (_, columnIndex) => {
      const x = originX + columnIndex;
      const y = originY + rowIndex;
      const player = rowIndex === CENTER && columnIndex === CENTER;
      const walls = {
        top: hasWall(map, x, y, "top"),
        right: hasWall(map, x, y, "right"),
        bottom: hasWall(map, x, y, "bottom"),
        left: hasWall(map, x, y, "left")
      };
      const doors = {
        top: doorState(map, x, y, "top"),
        right: doorState(map, x, y, "right"),
        bottom: doorState(map, x, y, "bottom"),
        left: doorState(map, x, y, "left")
      };
      const windows = {
        top: hasWindow(map, x, y, "top"),
        right: hasWindow(map, x, y, "right"),
        bottom: hasWindow(map, x, y, "bottom"),
        left: hasWindow(map, x, y, "left")
      };
      const outside = x < 0 || y < 0 || x >= map.gridColumns || y >= map.gridRows;
      // Small creatures are dots in their own cell; large ones are one outline spanning their whole footprint,
      // attached to the first visible cell of it. The player's own body is drawn the same way when it is large.
      const bodies = map.playerBody?.large
        ? [{ ...map.playerBody, id: map.playerTokenId, kind: "player", img: map.playerImg ?? "" }]
        : [];
      // Creatures overlapping each other or the player (same cell, or standing inside a large one's footprint) get
      // a tinted, dashed cell and corner badges, coloured by the most threatening kind present.
      // The player's own token counts as one occupant, so a single other creature there is already a shared cell.
      const sharing = map.tokens.filter(token => coversCell(token, x, y));
      const stacked = sharing.length > (player ? 0 : 1);
      const stackKind = stacked ? stackLead(sharing).kind : null;
      const stackDot = stacked && !player ? stackLead(sharing.filter(token => !token.large)) : null;
      let badgeSlot = 0;
      const tokens = [...bodies, ...map.tokens]
        .map(token => ({ token, placement: token.large ? windowPlacement(token, originX, originY) : null }))
        .filter(({ token, placement }) => token.large
          ? placement?.column === columnIndex && placement?.row === rowIndex
          : token.x === x && token.y === y)
        .map(({ token, placement }) => ({
          ...token,
          coLocated: !token.large && (player || (stacked && token !== stackDot)),
          ...(token.large ? { cols: token.w, rows: token.h, dx: placement.dx, dy: placement.dy } : {}),
          label: localize(TOKEN_KIND_LABEL[token.kind])
        }))
        // Several corner badges in one cell sit side by side instead of on top of each other.
        .map(token => token.coLocated ? { ...token, slot: Math.min(badgeSlot++, MAX_BADGE_SLOTS) } : token);
      // Standing anywhere inside a friendly creature's footprint counts as sharing its space.
      const occupiedFriendly = player
        && map.tokens.some(token => token.kind === "friendly" && coversCell(token, x, y));
      return {
        x,
        y,
        player,
        occupiedFriendly,
        stacked,
        stackKind,
        outside,
        debug: `${x},${y} T:${Number(walls.top)} R:${Number(walls.right)} B:${Number(walls.bottom)} L:${Number(walls.left)}`,
        className: `pocket5e-minimap-cell${player ? " player" : ""}${outside ? " outside" : ""}${occupiedFriendly ? " occupied-friendly" : ""}${stacked ? ` stacked stacked-${stackKind}` : ""}${tokens.length ? " has-token" : ""}${tokens.some(token => !token.large) ? " has-small-token" : ""}`,
        walls,
        doors,
        windows,
        tokens
      };
    })
  }));
}

/**
 * Read map data from the selected scene, filtering hidden tokens and requiring the selected actor's ownership.
 * No canvas or synthetic map is used. Scene artwork is optional (GM world setting) and cropped to the same
 * seven-cell window as the tokens.
 */
export function prepareMovementMap(scene, actor, user) {
  if ( !scene || !actor?.id || !ownedByUser(actor, user) ) {
    return { available: false, hasPlayer: false, sceneName: "", rows: [] };
  }

  const gridSize = Number(scene.grid?.size ?? scene.dimensions?.size);
  const width = Number(scene.width);
  const height = Number(scene.height);
  if ( !Number.isFinite(gridSize) || gridSize <= 0
    || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 ) {
    return { available: false, hasPlayer: false, sceneName: scene.navName || scene.name || "", rows: [] };
  }

  const columns = Math.ceil(width / gridSize);
  const rows = Math.ceil(height / gridSize);
  const sceneTokens = collectionValues(scene.tokens);
  const playerToken = sceneTokens.find(token => token.actorId === actor.id && token.hidden !== true);
  const player = playerToken ? tokenGridPosition(playerToken, gridSize) : null;
  if ( !player ) {
    return {
      available: true,
      hasPlayer: false,
      sceneId: scene.id,
      sceneName: scene.navName || scene.name || "",
      rows: [],
      cells: [],
      debug: minimapDebugEnabled()
    };
  }
  const map = {
    available: true,
    sceneId: scene.id,
    sceneName: scene.navName || scene.name || "",
    debug: minimapDebugEnabled(),
    hasPlayer: !!player,
    player,
    playerTokenId: playerToken.id ?? null,
    playerImg: tokenImage(playerToken, actor),
    playerBody: tokenFootprint(playerToken, player),
    originX: player.x - CENTER,
    originY: player.y - CENTER,
    columns,
    gridColumns: columns,
    gridRows: rows,
    sceneBackdrop: sceneBackdrop(scene, gridSize, columns, rows),
    wallEdges: makeWallEdges(scene, gridSize, columns, rows, user?.isGM === true),
    tokens: sceneTokens
      .filter(token => token.hidden !== true && token !== playerToken)
      .map(token => {
        const position = tokenGridPosition(token, gridSize);
        if ( !position ) return null;
        const tokenActor = token.actor ?? globalThis.game?.actors?.get(token.actorId);
        const kind = tokenKind(token, tokenActor);
        return {
          ...position,
          ...tokenFootprint(token, position),
          id: token.id ?? null,
          kind,
          name: token.name ?? tokenActor?.name ?? "",
          img: tokenImage(token, tokenActor),
          label: localize(TOKEN_KIND_LABEL[kind])
        };
      })
      .filter(Boolean)
  };
  map.rows = buildMovementMapWindow(map);
  map.cells = map.rows.flatMap(row => row.cells);
  map.worldPosition = { x: player.x + 1, y: player.y + 1 };
  return map;
}

/** Snapshot of what the minimap showed, in world coordinates, so the next render can animate the difference. */
export function captureMinimapState(map) {
  if ( !map?.available || !map.player ) return null;
  const tokens = new Map();
  for ( const token of map.tokens ) if ( token.id ) tokens.set(token.id, { x: token.x, y: token.y });
  if ( map.playerTokenId ) tokens.set(map.playerTokenId, { x: map.player.x, y: map.player.y });
  return { sceneId: map.sceneId, player: { x: map.player.x, y: map.player.y }, tokens };
}

const ANIMATION_MS = 220;
const MAX_ANIMATED_CELLS = 2;

/**
 * Animate the change between two minimap states, purely visually (the DOM is already final).
 * The view is always centred on the player, so a step pans every cell (walls, doors, windows, dots) by the
 * player's displacement. Each dot then gets its own extra slide equal to its world displacement: this keeps
 * the player's dot still in the centre and lets creatures that moved slide to their new cell.
 */
export function animateMinimap(grid, previous, next, { duration = ANIMATION_MS } = {}) {
  if ( !grid || !previous || !next || previous.sceneId !== next.sceneId ) return;
  if ( globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ) return;
  const dx = next.player.x - previous.player.x;
  const dy = next.player.y - previous.player.y;
  if ( Math.abs(dx) > MAX_ANIMATED_CELLS || Math.abs(dy) > MAX_ANIMATED_CELLS ) return;
  const options = { duration, easing: "ease-out" };
  const cells = Array.from(grid.querySelectorAll(".pocket5e-minimap-cell"));
  if ( !cells.length || typeof cells[0].animate !== "function" ) return;
  const { width, height } = cells[0].getBoundingClientRect();

  if ( dx || dy ) {
    for ( const cell of cells ) {
      cell.animate([{ translate: `${dx * 100}% ${dy * 100}%` }, { translate: "0 0" }], options);
    }
    const sceneLayer = grid.parentElement?.querySelector(".pocket5e-minimap-scene");
    // The scene layer is the whole 7×7, so one cell is `width` px — not 100% of this element.
    sceneLayer?.animate?.([{ translate: `${dx * width}px ${dy * height}px` }, { translate: "0 0" }], options);
  }
  for ( const dot of grid.querySelectorAll(".pocket5e-minimap-token[data-token-id]") ) {
    const id = dot.dataset.tokenId;
    const before = previous.tokens.get(id);
    const after = next.tokens.get(id);
    if ( !after ) continue;
    if ( !before ) {
      dot.animate([{ opacity: 0 }, { opacity: 1 }], options);
      continue;
    }
    const ex = before.x - after.x;
    const ey = before.y - after.y;
    if ( !ex && !ey ) continue;
    if ( Math.abs(ex) > MAX_ANIMATED_CELLS || Math.abs(ey) > MAX_ANIMATED_CELLS ) continue;
    dot.animate([{ translate: `${ex * width}px ${ey * height}px` }, { translate: "0 0" }], options);
  }
}
