// Copied from figma-console-mcp (MIT, see LICENSE in this folder): figma-desktop-bridge/code.js at commit 5ef4df3
// (https://github.com/southleft/figma-console-mcp). It has the handlers ANALYZE_COMPONENT_SET, LINT_DESIGN and
// AUDIT_COMPONENT_ACCESSIBILITY, and the helper extractSlots that the first one uses.
//
// Changes, to run as FigPal's pi helpers:
// - Each handler is an exported async function. It returns its data or throws, instead of posting a message.
// - The console logs are removed.
// - LINT_DESIGN (token-misuse): figma.variables.getVariableById is a sync API, which a plugin with
//   documentAccess "dynamic-page" cannot call. The lint loads the names of the local variables before the walk instead.
// - ANALYZE_COMPONENT_SET: the hint does not name MCP tools that FigPal does not have.
// - LINT_DESIGN: remove unused style and variable-ID maps; load variable names only for token-misuse.
// - LINT_DESIGN: the walk reads the children of a node once (wcag-reading-order and the recursion).
// - AUDIT_COMPONENT_ACCESSIBILITY: collect only the first 20 color pairs that the simulations use.
// - parseAxes, the default-variant search and the color blend are at the top, for all handlers.
// Fixes (FigPal tests in plugin/src/checks.test.ts):
// - LINT_DESIGN: large text uses Figma's numeric font weight (>= 700), not the strings "Bold" etc.
// - LINT_DESIGN and AUDIT_COMPONENT_ACCESSIBILITY: contrast uses the colors that show. The opacity of a paint blends it
//   with the color under it, and a transparent background blends with white. This applies to text, to the fill and
//   border of controls, and to focus rings.
// - LINT_DESIGN: an unknown rule or group throws, instead of a clean result.
// - LINT_DESIGN: the walk lets timers and input run every 500 nodes, and skips nodes removed in the meantime.
// - LINT_DESIGN and AUDIT_COMPONENT_ACCESSIBILITY: the default variant comes from findDefaultVariant, the search of
//   ANALYZE_COMPONENT_SET (whole state values such as "Enabled"). Before, they searched the full variant name for parts
//   of words ("Size=Base" matched), else always took the first child.
// - ANALYZE_COMPONENT_SET: variant names without a space after the comma give their axes (parseAxes).
// - ANALYZE_COMPONENT_SET: a removed paint is null in diffFromDefault. Before, JSON dropped the undefined value.
// - AUDIT_COMPONENT_ACCESSIBILITY: the axes state, status and interaction show interaction states, as whole words
//   ("Inactive" is not "active"). A presentational name (badge, tag, ...) stays presentational. The name test uses the
//   last part of a name such as "Controls/Button". With these rules each component is interactive or presentational,
//   so the upstream search for interaction words in ambiguous components is removed.
// Added:
// - LINT_DESIGN: the rule apca-contrast checks text contrast with APCA (apca-w3, the method of the WCAG 3 drafts) for
//   the size and weight of the text. It is in the group "wcag", so it runs with wcag-contrast by default.
// - LINT_DESIGN: the option timeLimitMs stops the walk, with a warning that says how far it got.

import { APCAcontrast, fontLookupAPCA, sRGBtoY } from "apca-w3";

// FigPal: the color of c at opacity a over the color under it. A paint without opacity is opaque.
function blend(c, under, a) {
  if (a === undefined) a = 1;
  return { r: c.r * a + under.r * (1 - a), g: c.g * a + under.g * (1 - a), b: c.b * a + under.b * (1 - a) };
}
// FigPal: what is under a transparent background is not known. White is a guess.
var WHITE = { r: 1, g: 1, b: 1 };

// Variant names are "Axis=Value, ..." in the author's casing. FigPal: shared by the handlers.
function parseAxes(name) {
  var out = {};
  var segs = name.split(',');
  for (var si = 0; si < segs.length; si++) {
    var kv = segs[si].split('=');
    if (kv.length === 2) out[kv[0].trim()] = kv[1].trim();
  }
  return out;
}

// Find the default variant (#121). Start from Figma's own default (the set's top-left variant). With a state axis,
// prefer the variant that matches it on every other axis but is in a resting state. Compare state values
// case-insensitively. FigPal: shared by the handlers.
var STATE_AXES = ['state', 'status', 'interaction'];
var RESTING_STATES = ['default', 'rest', 'resting', 'enabled', 'idle', 'normal', 'base'];
function findDefaultVariant(set) {
  var variants = set.children || [];
  var figmaDefault = null;
  try { figmaDefault = set.defaultVariant || null; } catch (e) {}
  if (!figmaDefault) figmaDefault = variants[0] || null;
  if (!figmaDefault) return null;
  var baseAxes = parseAxes(figmaDefault.name);
  var stateAxis = null;
  for (var key in baseAxes) {
    if (STATE_AXES.indexOf(key.toLowerCase()) !== -1) stateAxis = key;
  }
  if (!stateAxis || RESTING_STATES.indexOf(baseAxes[stateAxis].toLowerCase()) !== -1) return figmaDefault;
  for (var di = 0; di < variants.length; di++) {
    var cand = parseAxes(variants[di].name);
    var sameOtherAxes = true;
    for (var bk in baseAxes) {
      if (bk !== stateAxis && cand[bk] !== baseAxes[bk]) { sameOtherAxes = false; break; }
    }
    if (sameOtherAxes && RESTING_STATES.indexOf((cand[stateAxis] || '').toLowerCase()) !== -1) return variants[di];
  }
  return figmaDefault;
}

function extractSlots(node) {
  function canReadDefs(n) {
    if (n.type === 'COMPONENT_SET') return true;
    if (n.type === 'COMPONENT') return !(n.parent && n.parent.type === 'COMPONENT_SET');
    return false;
  }
  if (!canReadDefs(node)) return [];
  var defs;
  try { defs = node.componentPropertyDefinitions; } catch (e) { return []; }
  if (!defs) return [];
  var byProp = {};
  for (var k in defs) {
    if (defs[k] && defs[k].type === 'SLOT') {
      byProp[k] = {
        propertyName: k,
        description: defs[k].description || null,
        preferredValues: (defs[k].preferredValues || []).slice(),
        slotNodeIds: [],
        slotNames: [],
        limitViolations: []
      };
    }
  }
  if (Object.keys(byProp).length === 0) return [];
  // Link each SLOT child node (which carries limitViolations) back to its property
  // via componentPropertyReferences.slotContentId. A COMPONENT_SET has one SLOT node
  // per variant pointing at the same property, so results are grouped by property.
  var slotNodes = [];
  try { slotNodes = node.findAllWithCriteria({ types: ['SLOT'] }); }
  catch (e) {
    try { slotNodes = node.findAll(function(n) { return n.type === 'SLOT'; }); } catch (e2) { slotNodes = []; }
  }
  for (var i = 0; i < slotNodes.length; i++) {
    var sn = slotNodes[i];
    var refs = sn.componentPropertyReferences || {};
    var pk = refs.slotContentId;
    var entry = (pk && byProp[pk]) ? byProp[pk] : null;
    if (!entry) {
      entry = byProp[pk || sn.id] = { propertyName: pk || null, description: null, preferredValues: [], slotNodeIds: [], slotNames: [], limitViolations: [] };
    }
    entry.slotNodeIds.push(sn.id);
    if (entry.slotNames.indexOf(sn.name) === -1) entry.slotNames.push(sn.name);
    var lv = sn.limitViolations || [];
    for (var j = 0; j < lv.length; j++) { if (entry.limitViolations.indexOf(lv[j]) === -1) entry.limitViolations.push(lv[j]); }
  }
  return Object.keys(byProp).map(function(key) {
    var e = byProp[key];
    return {
      name: e.slotNames[0] || e.propertyName,
      propertyName: e.propertyName,
      description: e.description,
      preferredValues: e.preferredValues,
      instanceCount: e.slotNodeIds.length,
      limitViolations: e.limitViolations
    };
  });
}

export async function analyzeComponentSet(msg) {

      var node = await figma.getNodeByIdAsync(msg.nodeId);
      if (!node) throw new Error('Node not found: ' + msg.nodeId);
      if (node.type !== 'COMPONENT_SET') throw new Error('Node is not a COMPONENT_SET. Type: ' + node.type);

      // Build variable name lookup
      var varNameMap = {};
      try {
        var allVars = await figma.variables.getLocalVariablesAsync();
        var allColls = await figma.variables.getLocalVariableCollectionsAsync();
        var collMap = {};
        for (var ci = 0; ci < allColls.length; ci++) collMap[allColls[ci].id] = allColls[ci].name;
        for (var vi = 0; vi < allVars.length; vi++) {
          var v = allVars[vi];
          varNameMap[v.id] = { name: v.name, collection: collMap[v.variableCollectionId] || null, type: v.resolvedType };
        }
      } catch(e) {}

      function resolveVarId(id) {
        return varNameMap[id] ? varNameMap[id].name : id;
      }

      function resolveBoundColor(bv) {
        if (!bv) return null;
        // Handle array format (fills/strokes)
        if (Array.isArray(bv)) {
          return bv.length > 0 && bv[0].id ? resolveVarId(bv[0].id) : null;
        }
        // Handle object format
        if (bv.id) return resolveVarId(bv.id);
        if (bv.color && bv.color.id) return resolveVarId(bv.color.id);
        return null;
      }

      function round2(n) {
        return typeof n === 'number' && !isNaN(n) ? Math.round(n * 100) / 100 : undefined;
      }

      // A paint list as one comparable string: the bound token or hex for a
      // solid, the stops for a gradient, 'image'/'video' otherwise. Paint
      // opacity below 1 is appended ('@0.5'), extra visible paints as '+N'.
      // Without this, gradients, images and a stroke faded to 0 diff as equal.
      function paintSig(paints, bound) {
        if (!paints || typeof paints === 'symbol' || !paints.length) return null;
        var vis = [];
        for (var pi = 0; pi < paints.length; pi++) {
          if (paints[pi].visible !== false) vis.push(pi);
        }
        if (!vis.length) return null;
        var p = paints[vis[0]];
        var tok = null;
        if (p.boundVariables && p.boundVariables.color && p.boundVariables.color.id) tok = resolveVarId(p.boundVariables.color.id);
        else if (Array.isArray(bound) && bound[vis[0]] && bound[vis[0]].id) tok = resolveVarId(bound[vis[0]].id);
        var s;
        if (tok) s = tok;
        else if (p.type === 'SOLID' && p.color) s = colorHex(p.color);
        else if (p.type && p.type.indexOf('GRADIENT_') === 0) {
          s = p.type.slice(9).toLowerCase() + '-gradient(' + (p.gradientStops || []).map(function(g) { return colorHex(g.color); }).join(', ') + ')';
        } else s = (p.type || 'paint').toLowerCase();
        if (typeof p.opacity === 'number' && p.opacity < 1) s += ' @' + round2(p.opacity);
        if (vis.length > 1) s += ' +' + (vis.length - 1);
        return s;
      }

      // Corner radius as a number, or 'tl tr br bl' when corners differ;
      // bound corners use the token name. undefined for nodes without corners.
      var CORNERS = ['topLeftRadius', 'topRightRadius', 'bottomRightRadius', 'bottomLeftRadius'];
      function radiusSig(n) {
        try {
          var bv = n.boundVariables || {};
          var vals = [];
          for (var ri = 0; ri < CORNERS.length; ri++) {
            var b = bv[CORNERS[ri]];
            var val = b && b.id ? resolveVarId(b.id) : round2(n[CORNERS[ri]]);
            if (val === undefined) return undefined;
            vals.push(val);
          }
          return vals[0] === vals[1] && vals[1] === vals[2] && vals[2] === vals[3] ? vals[0] : vals.join(' ');
        } catch (e) { return undefined; }
      }

      // Tokens bound to anything other than paints and corners (padding, gap,
      // width, font size...). A variant can swap the token while the value in
      // the current mode stays the same.
      var SKIP_BOUND = { fills: 1, strokes: 1, effects: 1, componentProperties: 1, textRangeFills: 1, topLeftRadius: 1, topRightRadius: 1, bottomLeftRadius: 1, bottomRightRadius: 1 };
      function boundTokens(n) {
        var out = null;
        try {
          var bv = n.boundVariables || {};
          for (var bk in bv) {
            if (SKIP_BOUND[bk]) continue;
            var tk = resolveBoundColor(bv[bk]);
            if (tk) {
              if (!out) out = {};
              out[bk] = tk;
            }
          }
        } catch (e) {}
        return out;
      }

      // Keys whose values differ between two token maps (null = removed).
      function diffTokens(a, b) {
        a = a || {};
        b = b || {};
        var out = null;
        var k;
        for (k in a) if (a[k] !== b[k]) { if (!out) out = {}; out[k] = a[k]; }
        for (k in b) if (!(k in a)) { if (!out) out = {}; out[k] = null; }
        return out;
      }

      function shortHash(str) {
        var h = 5381;
        for (var hi = 0; hi < str.length; hi++) h = ((h << 5) + h + str.charCodeAt(hi)) | 0;
        return (h >>> 0).toString(16);
      }

      function textValue(v, fmt) {
        if (v === undefined || v === null) return null;
        if (typeof v === 'symbol') return 'mixed';
        return fmt ? fmt(v) : v;
      }
      function unitValue(u) {
        if (u.unit === 'AUTO') return 'auto';
        return round2(u.value) + (u.unit === 'PERCENT' ? '%' : 'px');
      }

      // Extract visual signature from a variant for diffing
      async function extractSignature(variant) {
        var sig = {};

        // Find the main interactive element — prioritize by: has strokes (input fields),
        // is a FRAME with fills and strokes, or is the largest visible non-text child
        var mainChild = null;
        if (variant.children) {
          // First pass: find child with strokes (likely the input/interactive element)
          for (var i = 0; i < variant.children.length; i++) {
            var child = variant.children[i];
            try {
              if (child.visible !== false && child.type !== 'TEXT' && child.strokes && child.strokes.length > 0) {
                mainChild = child;
                break;
              }
            } catch(e) {}
          }
          // Fallback: first visible FRAME child
          if (!mainChild) {
            for (var i2 = 0; i2 < variant.children.length; i2++) {
              var c2 = variant.children[i2];
              try {
                if (c2.visible !== false && c2.type === 'FRAME') {
                  mainChild = c2;
                  break;
                }
              } catch(e) {}
            }
          }
        }

        // No stroked/frame child: the variant itself carries the visuals
        // (e.g. a button whose fill sits on the component).
        if (!mainChild) mainChild = variant;
        // Layer paths whose values the top-level fields already report.
        sig._mainPath = mainChild === variant ? null : mainChild.name;
        sig._textPath = null;

        // Geometry and structure, so variants that differ in size or content
        // (2 icons vs 6 icons) don't diff as identical (#121).
        sig.width = Math.round(variant.width * 100) / 100;
        sig.height = Math.round(variant.height * 100) / 100;
        sig.children = variant.children ? variant.children.map(function(c) { return c.name; }) : [];

        if (mainChild) {
              var child = mainChild;
              // This is the main interactive frame
              try {
                var bv = child.boundVariables || {};
                sig.fillToken = resolveBoundColor(bv.fills);
                sig.strokeToken = resolveBoundColor(bv.strokes);
                sig.strokeWeight = child.strokeWeight;

                // Raw paint as fallback (hex, gradient or image, with opacity)
                if (!sig.fillToken) sig.fillHex = paintSig(child.fills) || undefined;
                if (!sig.strokeToken) sig.strokeHex = paintSig(child.strokes) || undefined;
                sig.effects = child.effects && child.effects.length > 0 ? child.effects : null;
                sig.opacity = child.opacity < 1 ? Math.round(child.opacity * 100) / 100 : null;
                var mr = radiusSig(child);
                if (mr !== undefined) sig.cornerRadius = mr;
              } catch(e) {}

              // Check text children for color changes
              if (child.children) {
                for (var t = 0; t < child.children.length; t++) {
                  var textChild = child.children[t];
                  if (textChild.type === 'TEXT') {
                    sig._textPath = sig._mainPath ? sig._mainPath + ' › ' + textChild.name : textChild.name;
                    try {
                      var tbv = textChild.boundVariables || {};
                      sig.textToken = resolveBoundColor(tbv.fills);
                      if (!sig.textToken) sig.textHex = paintSig(textChild.fills) || undefined;
                    } catch(e) {}
                    break; // First text node is enough
                  }
                }
              }
        }

        // Top-level layers that are hidden. _visible keeps every child's
        // visibility so the diff can compare both directions.
        sig.visibilityChanges = {};
        sig._visible = {};
        if (variant.children) {
          for (var j = 0; j < variant.children.length; j++) {
            var ch = variant.children[j];
            try {
              sig._visible[ch.name] = ch.visible !== false;
              if (!ch.visible) sig.visibilityChanges[ch.name] = false;
            } catch(e) {}
          }
        }

        // Opacity on the variant itself (a disabled state often lives here,
        // not on any child).
        sig.variantOpacity = variant.opacity < 1 ? Math.round(variant.opacity * 100) / 100 : null;

        // Fill and stroke on the variant itself. A button's background usually
        // sits here while the main layer picked above is its label frame, so
        // without these a hover that only changes the background diffs as
        // no change.
        sig.variantFill = null;
        sig.variantStroke = null;
        try {
          var vbv = variant.boundVariables || {};
          sig.variantFill = paintSig(variant.fills, vbv.fills);
          sig.variantStroke = paintSig(variant.strokes, vbv.strokes);
          var vr = radiusSig(variant);
          if (vr !== undefined) sig.variantRadius = vr;
        } catch(e) {}
        // Non-paint tokens on the variant (padding, gap, size). Diff-only.
        sig._tokens = boundTokens(variant);

        // Auto-layout on the variant itself, so axes like Alignment or Density
        // that only change layout don't diff as identical. Diff-only.
        sig._layout = null;
        try {
          if (variant.layoutMode && variant.layoutMode !== 'NONE') {
            sig._layout = {
              layoutMode: variant.layoutMode,
              primaryAxisAlignItems: variant.primaryAxisAlignItems,
              counterAxisAlignItems: variant.counterAxisAlignItems,
              itemSpacing: variant.itemSpacing,
              paddingTop: variant.paddingTop,
              paddingRight: variant.paddingRight,
              paddingBottom: variant.paddingBottom,
              paddingLeft: variant.paddingLeft
            };
          }
        } catch(e) {}

        // Nested layers, keyed by path. State changes often sit below the
        // first child (a checked radio swaps the icon instance; its vector's
        // fill token changes), which the fields above never see. Only used
        // for diffing — stripped from the response.
        sig._layers = {};
        var layerCount = 0;
        async function walkLayers(parent, prefix, depth) {
          if (!parent.children || depth > 4) return;
          var parentAuto = parent.layoutMode && parent.layoutMode !== 'NONE';
          var seen = {};
          for (var li = 0; li < parent.children.length && layerCount < 300; li++) {
            var ln = parent.children[li];
            var nm = ln.name;
            seen[nm] = (seen[nm] || 0) + 1;
            if (seen[nm] > 1) nm = nm + '#' + seen[nm];
            var path = prefix ? prefix + ' › ' + nm : nm;
            var entry = {};
            layerCount++;
            try {
              var lbv = ln.boundVariables || {};
              entry.fill = paintSig(ln.fills, lbv.fills);
              entry.stroke = paintSig(ln.strokes, lbv.strokes);
              entry.strokeWeight = entry.stroke ? (typeof ln.strokeWeight === 'number' ? ln.strokeWeight : null) : null;
              entry.opacity = ln.opacity < 1 ? Math.round(ln.opacity * 100) / 100 : null;
              entry.visible = ln.visible !== false;
              entry.radius = radiusSig(ln);
              entry.tokens = boundTokens(ln);
              // Size always; position only where auto-layout doesn't place
              // the layer (a tooltip's pointer moving between corners).
              entry.width = round2(ln.width);
              entry.height = round2(ln.height);
              if (!parentAuto || ln.layoutPositioning === 'ABSOLUTE') {
                entry.x = round2(ln.x);
                entry.y = round2(ln.y);
              }
              entry.rotation = ln.rotation ? round2(ln.rotation) : undefined;
              if (ln.type === 'ELLIPSE' && ln.arcData) {
                entry.shape = 'arc ' + round2(ln.arcData.startingAngle) + ' ' + round2(ln.arcData.endingAngle) + ' ' + round2(ln.arcData.innerRadius);
              } else if (ln.type === 'VECTOR' && ln.vectorPaths) {
                entry.shape = 'path#' + shortHash(JSON.stringify(ln.vectorPaths));
              }
              if (ln.type === 'TEXT') {
                entry.text = textValue(ln.characters, function(c) { return c.length > 80 ? c.slice(0, 80) + '…' : c; });
                entry.fontSize = textValue(ln.fontSize, round2);
                entry.font = textValue(ln.fontName, function(f) { return f.family + ' ' + f.style; });
                entry.textDecoration = textValue(ln.textDecoration);
                entry.textCase = textValue(ln.textCase);
                entry.lineHeight = textValue(ln.lineHeight, unitValue);
                entry.letterSpacing = textValue(ln.letterSpacing, unitValue);
              }
            } catch(e) {}
            if (ln.type === 'INSTANCE') {
              try {
                var mc = await ln.getMainComponentAsync();
                entry.component = mc ? mc.name : null;
              } catch(e) {}
            }
            sig._layers[path] = entry;
            await walkLayers(ln, path, depth + 1);
          }
        }
        await walkLayers(variant, '', 0);

        return sig;
      }

      function colorHex(c) {
        return '#' + Math.round(c.r*255).toString(16).padStart(2,'0') + Math.round(c.g*255).toString(16).padStart(2,'0') + Math.round(c.b*255).toString(16).padStart(2,'0');
      }

      // Signature as returned to the caller, without the diff-only fields.
      function publicSignature(sig) {
        var out = {};
        for (var k in sig) {
          if (k.charAt(0) !== '_') out[k] = sig[k];
        }
        return out;
      }

      // Parse variant property definitions
      var propDefs = node.componentPropertyDefinitions || {};
      var variantAxes = {};
      var componentProps = {};
      var propKeys = Object.keys(propDefs);
      for (var pk = 0; pk < propKeys.length; pk++) {
        var propKey = propKeys[pk];
        var propDef = propDefs[propKey];
        if (propDef.type === 'VARIANT') {
          variantAxes[propKey] = propDef.variantOptions || [];
        } else {
          componentProps[propKey] = {
            type: propDef.type,
            defaultValue: propDef.defaultValue
          };
        }
      }

      // CSS pseudo-class mapping for state variants
      var stateMapping = {
        'default': null,
        'hover': ':hover',
        'focus': ':focus-visible',
        'focus-visible': ':focus-visible',
        'focused': ':focus-visible',
        'active': ':active',
        'pressed': ':active',
        'disabled': ':disabled, [aria-disabled="true"]',
        'error': '[aria-invalid="true"]',
        'invalid': '[aria-invalid="true"]',
        'filled': '.has-value',
        'selected': '[aria-selected="true"]',
        'checked': ':checked',
        'loading': '[aria-busy="true"]',
        'readonly': '[readonly]',
        'open': '[aria-expanded="true"]',
        'closed': '[aria-expanded="false"]'
      };

      // Analyze variants grouped by axes
      var variants = node.children || [];
      var defaultVariant = null;
      var stateAxis = null;
      var sizeAxis = null;

      // Detect which axis is "state" and which is "size"
      var axisKeys = Object.keys(variantAxes);
      for (var ak = 0; ak < axisKeys.length; ak++) {
        var axisName = axisKeys[ak].toLowerCase();
        var axisValues = variantAxes[axisKeys[ak]];
        if (axisName === 'state' || axisName === 'status' || axisName === 'interaction') {
          stateAxis = axisKeys[ak];
        } else if (axisName === 'size' || axisName === 'scale') {
          sizeAxis = axisKeys[ak];
        }
      }

      // Build state machine from variants
      var stateMachine = { states: {}, defaultState: null, cssMapping: {} };
      var defaultSig = null;

      defaultVariant = findDefaultVariant(node);
      if (defaultVariant) {
        defaultSig = await extractSignature(defaultVariant);
      }

      // Process each variant and compute diff from default
      var variantDiffs = [];
      for (var vdi = 0; vdi < variants.length; vdi++) {
        var variant = variants[vdi];
        var sig = await extractSignature(variant);

        // Parse variant name to extract axis values
        var axisValues = parseAxes(variant.name);

        var stateValue = stateAxis ? (axisValues[stateAxis] || 'default') : 'default';
        var cssSelector = stateMapping[stateValue.toLowerCase()] || null;

        // Compute diff from default
        var diff = {};
        if (defaultSig && variant.id !== (defaultVariant ? defaultVariant.id : null)) {
          if (sig.fillToken !== defaultSig.fillToken) diff.fillToken = sig.fillToken || sig.fillHex || null;
          if (sig.strokeToken !== defaultSig.strokeToken) diff.strokeToken = sig.strokeToken || sig.strokeHex || null;
          if (sig.strokeWeight !== defaultSig.strokeWeight) diff.strokeWeight = sig.strokeWeight;
          if (sig.textToken !== defaultSig.textToken) diff.textToken = sig.textToken || sig.textHex || null;
          if (sig.opacity !== defaultSig.opacity) diff.opacity = sig.opacity;
          if (JSON.stringify(sig.effects) !== JSON.stringify(defaultSig.effects)) diff.effects = sig.effects;
          if (sig.width !== defaultSig.width) diff.width = sig.width;
          if (sig.height !== defaultSig.height) diff.height = sig.height;
          if (sig.fillHex !== defaultSig.fillHex && !diff.fillToken) diff.fillHex = sig.fillHex === undefined ? null : sig.fillHex;
          if (sig.strokeHex !== defaultSig.strokeHex && !diff.strokeToken) diff.strokeHex = sig.strokeHex === undefined ? null : sig.strokeHex;
          if (sig.textHex !== defaultSig.textHex && !diff.textToken) diff.textHex = sig.textHex === undefined ? null : sig.textHex;
          if (sig.cornerRadius !== defaultSig.cornerRadius) diff.cornerRadius = sig.cornerRadius === undefined ? null : sig.cornerRadius;
          if (JSON.stringify(sig.children) !== JSON.stringify(defaultSig.children)) {
            diff.children = {
              count: sig.children.length,
              added: sig.children.filter(function(n) { return defaultSig.children.indexOf(n) === -1; }),
              removed: defaultSig.children.filter(function(n) { return sig.children.indexOf(n) === -1; })
            };
          }
          // Top-level layers present in both whose visibility differs
          // (false = hidden in this variant, true = shown here but hidden in
          // the default).
          for (var vk in sig._visible) {
            if (Object.prototype.hasOwnProperty.call(defaultSig._visible, vk) && sig._visible[vk] !== defaultSig._visible[vk]) {
              if (!diff.visibilityChanges) diff.visibilityChanges = {};
              diff.visibilityChanges[vk] = sig._visible[vk];
            }
          }
          if ((sig._mainPath || defaultSig._mainPath) && sig.variantOpacity !== defaultSig.variantOpacity) diff.variantOpacity = sig.variantOpacity === null ? 1 : sig.variantOpacity;
          // When both use the variant as the main layer, fillToken/strokeToken
          // above already report these.
          if (sig._mainPath || defaultSig._mainPath) {
            if (sig.variantFill !== defaultSig.variantFill) diff.variantFill = sig.variantFill === undefined ? null : sig.variantFill;
            if (sig.variantStroke !== defaultSig.variantStroke) diff.variantStroke = sig.variantStroke === undefined ? null : sig.variantStroke;
            if (sig.variantRadius !== defaultSig.variantRadius) diff.variantRadius = sig.variantRadius === undefined ? null : sig.variantRadius;
          }
          var tokenDiff = diffTokens(sig._tokens, defaultSig._tokens);
          if (tokenDiff) diff.tokens = tokenDiff;

          // Nested layer changes, skipping values the fields above already
          // report so one change isn't listed twice.
          if (sig._layout || defaultSig._layout) {
            var la = sig._layout || {};
            var lb = defaultSig._layout || {};
            var layoutDiff = null;
            var layoutKeys = ['layoutMode', 'primaryAxisAlignItems', 'counterAxisAlignItems', 'itemSpacing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'];
            for (var lk = 0; lk < layoutKeys.length; lk++) {
              if (la[layoutKeys[lk]] !== lb[layoutKeys[lk]]) {
                if (!layoutDiff) layoutDiff = {};
                layoutDiff[layoutKeys[lk]] = la[layoutKeys[lk]] === undefined ? null : la[layoutKeys[lk]];
              }
            }
            if (layoutDiff) diff.layout = layoutDiff;
          }

          var layerProps = ['fill', 'stroke', 'strokeWeight', 'opacity', 'visible', 'component', 'radius', 'width', 'height', 'x', 'y', 'rotation', 'shape', 'text', 'fontSize', 'font', 'textDecoration', 'textCase', 'lineHeight', 'letterSpacing'];
          // Reported for the main layer by fillToken/strokeToken/opacity/cornerRadius.
          var mainCovered = { fill: 1, stroke: 1, strokeWeight: 1, opacity: 1, radius: 1 };
          for (var lp in sig._layers) {
            var dl = defaultSig._layers[lp];
            if (!dl) continue;
            var sl = sig._layers[lp];
            var isTop = lp.indexOf(' › ') === -1;
            var ld = null;
            for (var pi = 0; pi < layerProps.length; pi++) {
              var prop = layerProps[pi];
              if (prop === 'visible' && isTop) continue;
              if (lp === sig._mainPath && mainCovered[prop]) continue;
              if (lp === sig._textPath && prop === 'fill') continue;
              if (sl[prop] !== dl[prop]) {
                if (!ld) ld = {};
                ld[prop] = sl[prop] === undefined ? null : sl[prop];
              }
            }
            var ltd = diffTokens(sl.tokens, dl.tokens);
            if (ltd) {
              if (!ld) ld = {};
              ld.tokens = ltd;
            }
            if (ld) {
              if (!diff.layers) diff.layers = {};
              diff.layers[lp] = ld;
            }
          }
          var nestedAdded = [];
          var nestedRemoved = [];
          for (var ap2 in sig._layers) {
            if (ap2.indexOf(' › ') !== -1 && !defaultSig._layers[ap2] && nestedAdded.length < 20) nestedAdded.push(ap2);
          }
          for (var rp2 in defaultSig._layers) {
            if (rp2.indexOf(' › ') !== -1 && !sig._layers[rp2] && nestedRemoved.length < 20) nestedRemoved.push(rp2);
          }
          if (nestedAdded.length) diff.layersAdded = nestedAdded;
          if (nestedRemoved.length) diff.layersRemoved = nestedRemoved;
        }

        variantDiffs.push({
          name: variant.name,
          id: variant.id,
          axes: axisValues,
          state: stateValue,
          cssSelector: cssSelector,
          diffFromDefault: Object.keys(diff).length > 0 ? diff : null,
          signature: publicSignature(sig)
        });

        // Build CSS mapping
        if (cssSelector) {
          stateMachine.cssMapping[stateValue] = cssSelector;
        }
        if (!stateMachine.states[stateValue]) {
          stateMachine.states[stateValue] = [];
        }
        stateMachine.states[stateValue].push(variant.id);
      }

      if (defaultVariant) {
        var defaultAxes = parseAxes(defaultVariant.name);
        stateMachine.defaultState = stateAxis ? (defaultAxes[stateAxis] || 'default') : 'default';
        stateMachine.defaultVariant = { id: defaultVariant.id, name: defaultVariant.name };
        stateMachine.defaultSignature = publicSignature(defaultSig);
      }

      var result = {
        nodeId: node.id,
        nodeName: node.name,
        variantCount: variants.length,
        variantAxes: variantAxes,
        componentProps: componentProps,
        slots: extractSlots(node),
        stateMachine: stateMachine,
        variants: variantDiffs,
        ai_instruction: 'Use cssMapping to implement interaction states. diffFromDefault shows only what changes per state — apply these as CSS pseudo-class or attribute overrides. componentProps maps to React/Vue component props (BOOLEAN → boolean prop, TEXT → string prop, INSTANCE_SWAP → ReactNode/slot prop). slots lists Figma SLOT properties — implement each as a named slot / children prop (React: {children} or a named ReactNode prop; Web Components: <slot name>); preferredValues lists the components a slot accepts, and limitViolations flags content that breaks the slot\'s min/max rules.'
      };

      return result;
}

export async function lintDesign(msg) {

      // ---- Helper functions ----

      // sRGB linearization
      function lintLinearize(c) {
        return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
      }

      // Relative luminance (r, g, b in 0-1 range)
      function lintLuminance(r, g, b) {
        return 0.2126 * lintLinearize(r) + 0.7152 * lintLinearize(g) + 0.0722 * lintLinearize(b);
      }

      // Contrast ratio between two colors (each r, g, b in 0-1)
      function lintContrastRatio(r1, g1, b1, r2, g2, b2) {
        var l1 = lintLuminance(r1, g1, b1);
        var l2 = lintLuminance(r2, g2, b2);
        var lighter = Math.max(l1, l2);
        var darker = Math.min(l1, l2);
        return (lighter + 0.05) / (darker + 0.05);
      }

      // Convert 0-1 RGB to hex string
      function lintRgbToHex(r, g, b) {
        var rr = Math.round(r * 255).toString(16);
        var gg = Math.round(g * 255).toString(16);
        var bb = Math.round(b * 255).toString(16);
        if (rr.length === 1) rr = '0' + rr;
        if (gg.length === 1) gg = '0' + gg;
        if (bb.length === 1) bb = '0' + bb;
        return '#' + rr.toUpperCase() + gg.toUpperCase() + bb.toUpperCase();
      }

      // Walk up ancestors to find nearest solid fill background color
      function lintGetEffectiveBg(node) {
        var current = node.parent;
        while (current) {
          try {
            if (current.fills && current.fills.length > 0) {
              // Iterate reverse (last = topmost visible fill in Figma's stack)
              for (var fi = current.fills.length - 1; fi >= 0; fi--) {
                var fill = current.fills[fi];
                if (fill.type === 'SOLID' && fill.visible !== false) {
                  var opacity = (fill.opacity !== undefined) ? fill.opacity : 1;
                  return { r: fill.color.r, g: fill.color.g, b: fill.color.b, opacity: opacity };
                }
              }
            }
          } catch (e) {
            // Slot sublayer — skip
          }
          current = current.parent;
        }
        // Default to white if no bg found
        return { r: 1, g: 1, b: 1, opacity: 1 };
      }

      // Check if text qualifies as "large" per WCAG (18pt=24px regular, 14pt≈18.66px bold 700+)
      function lintIsLargeText(fontSize, fontWeight) {
        if (fontSize >= 24) return true;
        if (fontSize >= 18.66 && typeof fontWeight === 'number' && fontWeight >= 700) return true;
        return false;
      }

      // Line/paragraph SPACING only affects readability when text actually renders on
      // 2+ lines (or 2+ paragraphs). Single-line labels, buttons, inputs and headings
      // gain nothing from a 1.5 line height, so flagging them is false-positive noise.
      // (WCAG 1.4.12 conformance is a code concern — whether spacing overrides break
      // layout — not something a design's spacing value can prove. These stay best-practice.)
      function textRendersMultipleLines(node, effectiveLh) {
        try {
          var chars = (typeof node.characters === 'string') ? node.characters : '';
          // \n = paragraph break; U+2028 = line break (shift-enter) within a Figma paragraph
          var LINE_SEP = String.fromCharCode(0x2028);
          if (chars.indexOf(String.fromCharCode(10)) !== -1 || chars.indexOf(LINE_SEP) !== -1) return true;
          // WIDTH_AND_HEIGHT auto-resize grows horizontally and never wraps on its own
          if (node.textAutoResize === 'WIDTH_AND_HEIGHT') return false;
          if (effectiveLh && typeof node.height === 'number' && node.height > 0) {
            return (node.height / effectiveLh) >= 1.6; // ≈ 2+ rendered lines
          }
        } catch (e) { /* mixed/slot — treat as single line */ }
        return false;
      }

      function textHasMultipleParagraphs(node) {
        try {
          var chars = (typeof node.characters === 'string') ? node.characters : '';
          return chars.indexOf('\n') !== -1; // \n = paragraph separator in Figma text
        } catch (e) { /* ignore */ }
        return false;
      }

      // ---- Rule configuration ----
      var allRuleIds = [
        'wcag-contrast', 'apca-contrast', 'wcag-text-size', 'wcag-target-size', 'wcag-line-height',
        'wcag-non-text-contrast', 'wcag-color-only', 'wcag-focus-indicator',
        'wcag-letter-spacing', 'wcag-paragraph-spacing', 'wcag-image-alt',
        'wcag-heading-hierarchy', 'wcag-reflow', 'wcag-reading-order',
        'wcag-disabled-no-context', 'token-misuse',
        'hardcoded-color', 'no-text-style', 'default-name', 'detached-component',
        'no-autolayout', 'empty-container'
      ];

      var ruleGroups = {
        'all': allRuleIds,
        // 'wcag' = genuine WCAG conformance criteria only. Readability "best practice"
        // checks (text size, line/letter/paragraph spacing) live in 'best-practice' so a
        // conformance audit (rules: ['wcag']) is not polluted by non-normative hints.
        // In particular, WCAG 1.4.12 Text Spacing is a "support user overrides without
        // breaking" criterion — NOT a requirement to ship specific spacing values — so a
        // sub-1.5 line height is not a conformance failure (see 'best-practice' below).
        // FigPal: apca-contrast (WCAG 3 draft method) runs with WCAG 2 by default, so that the user sees both.
        'wcag': [
          'wcag-contrast', 'apca-contrast', 'wcag-target-size',
          'wcag-non-text-contrast', 'wcag-color-only', 'wcag-focus-indicator',
          'wcag-image-alt', 'wcag-heading-hierarchy', 'wcag-reflow', 'wcag-reading-order',
          'wcag-disabled-no-context'
        ],
        // Readability best practices — useful hints, NOT WCAG conformance failures.
        // Opt in with rules: ['best-practice'] (or ['all']); excluded from the default set.
        'best-practice': [
          'wcag-text-size', 'wcag-line-height', 'wcag-letter-spacing', 'wcag-paragraph-spacing'
        ],
        'design-system': ['hardcoded-color', 'no-text-style', 'default-name', 'detached-component', 'token-misuse'],
        'layout': ['no-autolayout', 'empty-container']
      };

      var severityMap = {
        'wcag-contrast': 'critical',
        'apca-contrast': 'critical',
        'wcag-target-size': 'critical',
        'wcag-non-text-contrast': 'critical',
        'wcag-color-only': 'critical',
        'wcag-focus-indicator': 'critical',
        'wcag-text-size': 'warning',
        'wcag-letter-spacing': 'warning',
        'wcag-image-alt': 'warning',
        'wcag-heading-hierarchy': 'warning',
        'wcag-reflow': 'warning',
        'wcag-reading-order': 'warning',
        'wcag-disabled-no-context': 'warning',
        'wcag-line-height': 'info',
        'wcag-paragraph-spacing': 'info',
        'token-misuse': 'warning',
        'hardcoded-color': 'warning',
        'no-text-style': 'warning',
        'default-name': 'warning',
        'detached-component': 'warning',
        'no-autolayout': 'warning',
        'empty-container': 'info'
      };

      // WCAG conformance level per rule — lets teams filter by target level (AA vs AAA)
      var wcagLevelMap = {
        'wcag-contrast': 'aa',           // 1.4.3 Contrast (Minimum) — Level AA
        'apca-contrast': 'wcag3-draft',  // FigPal: APCA, the contrast method of the WCAG 3 drafts
        'wcag-target-size': 'aa',        // 2.5.8 Target Size (Minimum) — Level AA
        'wcag-non-text-contrast': 'aa',  // 1.4.11 Non-text Contrast — Level AA
        'wcag-color-only': 'a',          // 1.4.1 Use of Color — Level A
        'wcag-focus-indicator': 'aa',    // 2.4.7 Focus Visible — Level AA
        'wcag-text-size': 'best-practice', // Not actually 1.4.4; 12px minimum is a readability best practice
        'wcag-line-height': 'best-practice', // 1.4.12 is about supporting user overrides, not requiring specific values
        'wcag-letter-spacing': 'best-practice', // Negative spacing actively harms readability
        'wcag-paragraph-spacing': 'best-practice', // 1.4.12 is about supporting user overrides
        'wcag-image-alt': 'a',           // 1.1.1 Non-text Content — Level A
        'wcag-heading-hierarchy': 'a',   // 1.3.1 Info and Relationships — Level A
        'wcag-reflow': 'aa',            // 1.4.10 Reflow — Level AA
        'wcag-reading-order': 'a',       // 1.3.2 Meaningful Sequence — Level A
        'wcag-disabled-no-context': 'aa', // 4.1.2 Name, Role, Value — disabled elements need ARIA context
        'token-misuse': 'design-system',
        'hardcoded-color': 'design-system',
        'no-text-style': 'design-system',
        'default-name': 'design-system',
        'detached-component': 'design-system',
        'no-autolayout': 'design-system',
        'empty-container': 'design-system'
      };

      var ruleDescriptions = {
        'wcag-contrast': 'Text does not meet WCAG AA contrast ratio (4.5:1 normal, 3:1 large text ≥24px or ≥18.5px bold). Best practice: always target 4.5:1, especially in dark mode.',
        'apca-contrast': 'Text does not reach the APCA contrast (Lc) for its size and weight. APCA is the contrast method of the WCAG 3 drafts; its font table gives the smallest font size for each weight at a contrast. Lc is negative for light text on dark. Paragraphs of body text need Lc 15 more when under Lc 75. At weight 800 and 900 the table also has a smallest size at any contrast: there the fix is a larger size or a lighter weight, not a color. Pass and fail can differ from WCAG 2.',
        'wcag-text-size': 'Text size is below 12px — readability best practice. Note: WCAG 1.4.4 requires supporting 200% text-only zoom (use rem/em units), not a specific minimum size.',
        'wcag-target-size': 'Interactive element is smaller than 24x24px minimum target size (WCAG 2.5.8)',
        'wcag-line-height': 'Multi-line body text has line height below 1.5x font size — a readability best practice (only flagged on text that wraps to 2+ lines; single-line labels, buttons and headings are exempt). NOT a WCAG failure: 1.4.12 requires content to survive a user overriding line height to 1.5x without loss of content, which is verified in code, not by the default value in the design.',
        'wcag-non-text-contrast': 'UI component or graphical object does not meet 3:1 contrast ratio against adjacent color. Also applies to borders and chart elements against adjacent elements (WCAG 1.4.11)',
        'wcag-color-only': 'Information is conveyed only through color change (e.g., error state uses red border without an error message or icon). Color can supplement but must not be the sole indicator (WCAG 1.4.1)',
        'wcag-focus-indicator': 'Interactive component is missing a focus/focused variant or the focus indicator is insufficient. A visible focus state is critical — without it, keyboard users cannot navigate the interface (WCAG 2.4.7)',
        'wcag-letter-spacing': 'Negative letter spacing (tighter than default) harms readability — a best-practice hint, not a WCAG failure. WCAG 1.4.12 is about supporting user-overridden spacing without loss of content (verified in code), not the default tracking in the design.',
        'wcag-paragraph-spacing': 'Multi-paragraph text has paragraph spacing below 2x font size — a readability best practice (only flagged when a text node has 2+ paragraphs). NOT a WCAG failure: 1.4.12 requires content to survive a user overriding paragraph spacing to 2x without loss of content, verified in code, not by the default value in the design.',
        'wcag-image-alt': 'Image or image fill has no description annotation for alternative text. All images need alt text; decorative images should be explicitly marked as decorative. Graphs and charts also need long descriptions (e.g., a data table) (WCAG 1.1.1)',
        'wcag-heading-hierarchy': 'Heading levels skip a level (e.g., H1 followed by H3). Use H1 through H6 sequentially without skipping levels (WCAG 1.3.1)',
        'wcag-reflow': 'Frame uses fixed positioning without auto-layout. Content must support 400% zoom on 1280px viewport (equivalent to 320px minimum width) without horizontal scrolling or loss of content (WCAG 1.4.10)',
        'wcag-reading-order': 'Visual position of elements does not match layer order. Keyboard navigation and screen reader order must follow a logical sequence (WCAG 1.3.2)',
        'wcag-disabled-no-context': 'Disabled variant has no tooltip, helper text, or annotation explaining why the element is disabled. Use aria-disabled (not HTML disabled) to keep the element focusable for screen readers, and add a tooltip so all users understand the disabled reason.',
        'token-misuse': 'Variable name prefix does not match its usage context (e.g., a bg/* token used as a text fill, or a text/* token used as a background). This may cause contrast issues and indicates a misbound token.',
        'hardcoded-color': 'Fill color is not bound to a variable or style',
        'no-text-style': 'Text node is not using a text style',
        'default-name': 'Node has a default Figma name (e.g., "Frame 1")',
        'detached-component': 'Frame uses component naming convention but is not a component or instance',
        'no-autolayout': 'Frame with multiple children does not use auto-layout',
        'empty-container': 'Frame has no children'
      };

      var defaultNameRegex = /^(Frame|Rectangle|Ellipse|Line|Text|Group|Component|Instance|Vector|Polygon|Star|Section)(\s+\d+)?$/;
      var interactiveNameRegex = /button|link|input|checkbox|radio|switch|toggle|tab|menu-item/i;

      // ---- Additional helpers for new WCAG rules ----

      // Get the first visible solid fill color from a node (for non-text contrast)
      function lintGetNodeFillColor(node) {
        try {
          var fills = node.fills;
          if (fills && fills.length > 0) {
            for (var i = fills.length - 1; i >= 0; i--) {
              if (fills[i].type === 'SOLID' && fills[i].visible !== false) {
                return { r: fills[i].color.r, g: fills[i].color.g, b: fills[i].color.b, opacity: fills[i].opacity };
              }
            }
          }
        } catch (e) { /* slot sublayer */ }
        return null;
      }

      // Get the first visible solid stroke color from a node
      function lintGetNodeStrokeColor(node) {
        try {
          var strokes = node.strokes;
          if (strokes && strokes.length > 0) {
            for (var i = strokes.length - 1; i >= 0; i--) {
              if (strokes[i].type === 'SOLID' && strokes[i].visible !== false) {
                return { r: strokes[i].color.r, g: strokes[i].color.g, b: strokes[i].color.b, opacity: strokes[i].opacity };
              }
            }
          }
        } catch (e) { /* slot sublayer */ }
        return null;
      }

      // Check if a node has any non-color visual differentiation (icon children, text change, border)
      function lintHasNonColorIndicator(node) {
        try {
          if (!node.children) return false;
          for (var i = 0; i < node.children.length; i++) {
            var child = node.children[i];
            try {
              // Icons are typically vectors, instances, or small frames with vector children
              if (child.type === 'VECTOR' || child.type === 'BOOLEAN_OPERATION') return true;
              if (child.type === 'INSTANCE') return true;
              // Check for visible strokes (borders)
              if (child.strokes && child.strokes.length > 0) {
                for (var si = 0; si < child.strokes.length; si++) {
                  if (child.strokes[si].visible !== false) return true;
                }
              }
            } catch (e) { /* skip */ }
          }
        } catch (e) { /* no children */ }
        return false;
      }

      // Heading level detection from text style name or font size
      var headingStyleRegex = /\bh(\d)\b|heading[\s-]*(\d)/i;
      function lintGetHeadingLevel(node) {
        // Try text style name first
        try {
          if (node.textStyleId && typeof node.textStyleId === 'string') {
            // We can't resolve style name in plugin sandbox directly from ID alone,
            // but we check the node name and font size as fallback
          }
        } catch (e) { /* skip */ }
        // Check node name for heading patterns
        try {
          var match = headingStyleRegex.exec(node.name);
          if (match) return parseInt(match[1] || match[2], 10);
        } catch (e) { /* skip */ }
        // Infer from font size (common convention)
        try {
          var fs = node.fontSize;
          if (typeof fs === 'number') {
            if (fs >= 40) return 1;
            if (fs >= 32) return 2;
            if (fs >= 24) return 3;
            if (fs >= 20) return 4;
            if (fs >= 18) return 5;
          }
        } catch (e) { /* mixed */ }
        return 0; // Not a heading
      }

      // Tracking for heading hierarchy check (reset per root scan)
      var headingSequence = [];

      // Tracking for reading order check — collect positioned children per parent
      // (checked after tree walk per-frame)

      // ---- Resolve active rules ----
      // Default audit = real WCAG conformance + design-system + layout. Best-practice
      // readability hints are opt-in (rules: ['best-practice'] or ['all']) so component
      // library audits aren't flooded with non-normative spacing/size noise.
      var requestedRules = msg.rules || ['wcag', 'design-system', 'layout'];
      var activeRuleSet = {};
      for (var ri = 0; ri < requestedRules.length; ri++) {
        var ruleOrGroup = requestedRules[ri];
        if (ruleGroups[ruleOrGroup]) {
          var groupRules = ruleGroups[ruleOrGroup];
          for (var gi = 0; gi < groupRules.length; gi++) {
            activeRuleSet[groupRules[gi]] = true;
          }
        } else if (severityMap[ruleOrGroup]) {
          activeRuleSet[ruleOrGroup] = true;
        } else {
          throw new Error('Unknown lint rule "' + ruleOrGroup + '". Use a rule ID or a group: ' + Object.keys(ruleGroups).join(', ') + '.');
        }
      }

      var maxDepth = typeof msg.maxDepth === 'number' ? msg.maxDepth : 10;
      var maxFindings = typeof msg.maxFindings === 'number' ? msg.maxFindings : 100;
      // FigPal: a time limit. FigPal's lint request does not run inside figma_execute, so without it a long lint would
      // block the other requests.
      var timeLimitMs = typeof msg.timeLimitMs === 'number' ? msg.timeLimitMs : null;
      var deadline = timeLimitMs === null ? null : Date.now() + timeLimitMs;
      var timedOut = false;

      // ---- Resolve root node ----
      var rootNode;
      if (msg.nodeId) {
        rootNode = await figma.getNodeByIdAsync(msg.nodeId);
        if (!rootNode) {
          throw new Error('Node not found: ' + msg.nodeId);
        }
      } else {
        rootNode = figma.currentPage;
      }

      // ---- Variable names for token-misuse ----
      var variableNames = {};
      if (activeRuleSet['token-misuse']) {
        try {
          var localVars = await figma.variables.getLocalVariablesAsync();
          for (var vi = 0; vi < localVars.length; vi++) {
            variableNames[localVars[vi].id] = localVars[vi].name;
          }
        } catch (e) { /* ignore */ }
      }

      // ---- Findings storage ----
      var findings = {};
      for (var ai = 0; ai < allRuleIds.length; ai++) {
        if (activeRuleSet[allRuleIds[ai]]) {
          findings[allRuleIds[ai]] = [];
        }
      }
      var totalFindings = 0;
      var nodesScanned = 0;
      var truncated = false;

      // ---- Tree walk ----
      async function walkNode(node, depth) {
        if (depth > maxDepth) return;
        if (truncated) return;
        if (deadline !== null && Date.now() >= deadline) {
          timedOut = true;
          truncated = true;
          return;
        }
        // Let timers and input run. The user can change the file in the meantime: skip a removed node.
        if (nodesScanned > 0 && nodesScanned % 500 === 0) {
          await new Promise(function(resolve) { setTimeout(resolve, 0); });
          try { if (node.removed) return; } catch (e) { return; }
        }

        nodesScanned++;

        var nodeType, nodeName, nodeId;
        try {
          nodeType = node.type;
          nodeName = node.name;
          nodeId = node.id;
        } catch (e) {
          return; // Slot sublayer — skip entirely
        }

        // Skip pages for most checks but still recurse into their children
        var isPage = nodeType === 'PAGE';
        var isSection = nodeType === 'SECTION';

        // ---- WCAG checks ----

        // wcag-contrast and apca-contrast (FigPal): TEXT nodes
        if ((activeRuleSet['wcag-contrast'] || activeRuleSet['apca-contrast']) && nodeType === 'TEXT' && !truncated) {
          try {
            var fills = node.fills;
            if (fills && fills.length > 0) {
              for (var fci = 0; fci < fills.length; fci++) {
                if (fills[fci].type === 'SOLID' && fills[fci].visible !== false) {
                  var fgOpacity = (fills[fci].opacity !== undefined) ? fills[fci].opacity : 1;
                  var bgFill = lintGetEffectiveBg(node);
                  // The colors that show: a transparent background over white, the text over that background.
                  var bg = blend(bgFill, WHITE, bgFill.opacity);
                  var fg = blend(fills[fci].color, bg, fgOpacity);
                  var ratio = lintContrastRatio(fg.r, fg.g, fg.b, bg.r, bg.g, bg.b);
                  var fontSize = 16;
                  var fontWeight = null;
                  try { fontSize = node.fontSize; } catch (e) { /* mixed */ }
                  try { fontWeight = node.fontWeight; } catch (e) { /* mixed */ }
                  if (typeof fontSize !== 'number') fontSize = 16;
                  var isLarge = lintIsLargeText(fontSize, fontWeight);
                  var required = isLarge ? 3.0 : 4.5;
                  // What is under a transparent background is not known: white is a guess.
                  var approximate = bgFill.opacity < 1;
                  if (activeRuleSet['wcag-contrast'] && ratio < required) {
                    if (totalFindings < maxFindings) {
                      var finding = {
                        id: nodeId,
                        name: nodeName,
                        ratio: ratio.toFixed(1) + ':1',
                        required: required.toFixed(1) + ':1',
                        fg: lintRgbToHex(fg.r, fg.g, fg.b),
                        bg: lintRgbToHex(bg.r, bg.g, bg.b)
                      };
                      if (approximate) finding.approximate = true;
                      findings['wcag-contrast'].push(finding);
                      totalFindings++;
                    } else {
                      truncated = true;
                    }
                  }
                  if (activeRuleSet['apca-contrast']) {
                    // FigPal: after WCAG 2, so that the known standard gets the last place at maxFindings. APCA reads 0-255
                    // values, text first, and keeps its sign: negative for light text on dark. The font table of apca-w3 gives
                    // the smallest size for each weight from 100 to 900 at the contrast; 777 and 999 mean "not for text".
                    var lcSigned = APCAcontrast(sRGBtoY([fg.r * 255, fg.g * 255, fg.b * 255]), sRGBtoY([bg.r * 255, bg.g * 255, bg.b * 255]));
                    var lc = Math.abs(lcSigned);
                    var weightIndex = Math.min(9, Math.max(1, Math.round((typeof fontWeight === 'number' ? fontWeight : 400) / 100)));
                    var minSize = Number(fontLookupAPCA(lc)[weightIndex]);
                    if (minSize >= 777 || fontSize < minSize) {
                      if (totalFindings < maxFindings) {
                        var apcaFinding = {
                          id: nodeId,
                          name: nodeName,
                          lc: 'Lc ' + Math.trunc(lcSigned),
                          required: minSize >= 777 ? 'not for text' : minSize + ' px at weight ' + weightIndex * 100,
                          fg: lintRgbToHex(fg.r, fg.g, fg.b),
                          bg: lintRgbToHex(bg.r, bg.g, bg.b)
                        };
                        if (approximate) apcaFinding.approximate = true;
                        findings['apca-contrast'].push(apcaFinding);
                        totalFindings++;
                      } else {
                        truncated = true;
                      }
                    }
                  }
                  break; // Only check the first visible solid fill
                }
              }
            }
          } catch (e) { /* slot sublayer */ }
        }

        // wcag-text-size: TEXT nodes with fontSize < 12
        if (activeRuleSet['wcag-text-size'] && nodeType === 'TEXT' && !truncated) {
          try {
            var ts = node.fontSize;
            if (typeof ts === 'number' && ts < 12) {
              if (totalFindings < maxFindings) {
                findings['wcag-text-size'].push({
                  id: nodeId,
                  name: nodeName,
                  fontSize: ts
                });
                totalFindings++;
              } else {
                truncated = true;
              }
            }
          } catch (e) { /* slot sublayer or mixed */ }
        }

        // wcag-target-size: Interactive elements < 24x24
        if (activeRuleSet['wcag-target-size'] && !isPage && !isSection && !truncated) {
          try {
            if ((nodeType === 'FRAME' || nodeType === 'COMPONENT' || nodeType === 'INSTANCE' || nodeType === 'COMPONENT_SET') && interactiveNameRegex.test(nodeName)) {
              var tw = node.width;
              var th = node.height;
              if ((typeof tw === 'number' && tw < 24) || (typeof th === 'number' && th < 24)) {
                if (totalFindings < maxFindings) {
                  findings['wcag-target-size'].push({
                    id: nodeId,
                    name: nodeName,
                    width: tw,
                    height: th
                  });
                  totalFindings++;
                } else {
                  truncated = true;
                }
              }
            }
          } catch (e) { /* slot sublayer */ }
        }

        // wcag-line-height: TEXT nodes where lineHeight < 1.5 * fontSize
        if (activeRuleSet['wcag-line-height'] && nodeType === 'TEXT' && !truncated) {
          try {
            var lh = node.lineHeight;
            var fs = node.fontSize;
            var effectiveLh = null;
            if (lh && typeof fs === 'number' && typeof lh === 'object' && typeof lh.value === 'number') {
              if (lh.unit === 'PIXELS') {
                effectiveLh = lh.value;
              } else if (lh.unit === 'PERCENT') {
                effectiveLh = fs * (lh.value / 100);
              }
            }
            if (effectiveLh !== null && effectiveLh < 1.5 * fs && textRendersMultipleLines(node, effectiveLh)) {
              if (totalFindings < maxFindings) {
                findings['wcag-line-height'].push({
                  id: nodeId,
                  name: nodeName,
                  lineHeight: effectiveLh,
                  fontSize: fs,
                  recommended: (1.5 * fs).toFixed(1)
                });
                totalFindings++;
              } else {
                truncated = true;
              }
            }
          } catch (e) { /* slot sublayer or mixed */ }
        }

        // wcag-non-text-contrast: UI components need 3:1 against adjacent color (WCAG 1.4.11)
        if (activeRuleSet['wcag-non-text-contrast'] && !isPage && !isSection && !truncated) {
          try {
            if ((nodeType === 'FRAME' || nodeType === 'COMPONENT' || nodeType === 'INSTANCE' || nodeType === 'COMPONENT_SET') && interactiveNameRegex.test(nodeName)) {
              // The colors that show.
              var uiBgFill = lintGetEffectiveBg(node);
              var uiBg = blend(uiBgFill, WHITE, uiBgFill.opacity);
              var uiFill = lintGetNodeFillColor(node);
              if (uiFill) uiFill = blend(uiFill, uiBg, uiFill.opacity);
              var uiStroke = lintGetNodeStrokeColor(node);
              if (uiStroke) uiStroke = blend(uiStroke, uiBg, uiStroke.opacity);
              // Check fill against background
              if (uiFill) {
                var uiRatio = lintContrastRatio(uiFill.r, uiFill.g, uiFill.b, uiBg.r, uiBg.g, uiBg.b);
                if (uiRatio < 3.0) {
                  if (totalFindings < maxFindings) {
                    findings['wcag-non-text-contrast'].push({
                      id: nodeId,
                      name: nodeName,
                      ratio: uiRatio.toFixed(1) + ':1',
                      required: '3.0:1',
                      component: lintRgbToHex(uiFill.r, uiFill.g, uiFill.b),
                      bg: lintRgbToHex(uiBg.r, uiBg.g, uiBg.b),
                      element: 'fill'
                    });
                    totalFindings++;
                  } else { truncated = true; }
                }
              }
              // Check stroke/border against background
              if (uiStroke && !truncated) {
                var strokeRatio = lintContrastRatio(uiStroke.r, uiStroke.g, uiStroke.b, uiBg.r, uiBg.g, uiBg.b);
                if (strokeRatio < 3.0) {
                  if (totalFindings < maxFindings) {
                    findings['wcag-non-text-contrast'].push({
                      id: nodeId,
                      name: nodeName,
                      ratio: strokeRatio.toFixed(1) + ':1',
                      required: '3.0:1',
                      component: lintRgbToHex(uiStroke.r, uiStroke.g, uiStroke.b),
                      bg: lintRgbToHex(uiBg.r, uiBg.g, uiBg.b),
                      element: 'stroke'
                    });
                    totalFindings++;
                  } else { truncated = true; }
                }
              }
            }
          } catch (e) { /* slot sublayer */ }
        }

        // wcag-color-only: Component variants that differ only by color (WCAG 1.4.1)
        if (activeRuleSet['wcag-color-only'] && nodeType === 'COMPONENT_SET' && !truncated) {
          try {
            var variants = node.children;
            if (variants && variants.length >= 2) {
              // Compare each variant pair for color-only differentiation
              for (var vi = 0; vi < variants.length && !truncated; vi++) {
                var variant = variants[vi];
                try {
                  var vName = variant.name.toLowerCase();
                  // Only check state-related variants (error, warning, success, disabled)
                  if (/(error|warning|danger|success|invalid|alert)/.test(vName)) {
                    if (!lintHasNonColorIndicator(variant)) {
                      // Check if this variant's fill differs from default
                      var defaultVariant = findDefaultVariant(node);
                      if (defaultVariant) {
                        var varFill = lintGetNodeFillColor(variant);
                        var defFill = lintGetNodeFillColor(defaultVariant);
                        if (varFill && defFill && (varFill.r !== defFill.r || varFill.g !== defFill.g || varFill.b !== defFill.b)) {
                          if (totalFindings < maxFindings) {
                            findings['wcag-color-only'].push({
                              id: variant.id,
                              name: nodeName + ' / ' + variant.name,
                              variantColor: lintRgbToHex(varFill.r, varFill.g, varFill.b),
                              defaultColor: lintRgbToHex(defFill.r, defFill.g, defFill.b),
                              suggestion: 'Add an icon, text label, or border to differentiate this state beyond color alone'
                            });
                            totalFindings++;
                          } else { truncated = true; }
                        }
                      }
                    }
                  }
                } catch (e) { /* skip variant */ }
              }
            }
          } catch (e) { /* slot sublayer */ }
        }

        // wcag-focus-indicator: Interactive components missing focus variant (WCAG 2.4.7)
        if (activeRuleSet['wcag-focus-indicator'] && nodeType === 'COMPONENT_SET' && !truncated) {
          try {
            if (interactiveNameRegex.test(nodeName)) {
              var hasFocusVariant = false;
              var focusVariantNode = null;
              var csVariants = node.children;
              if (csVariants) {
                for (var fvi = 0; fvi < csVariants.length; fvi++) {
                  var fvName = csVariants[fvi].name.toLowerCase();
                  if (/focus|focused/.test(fvName)) {
                    hasFocusVariant = true;
                    focusVariantNode = csVariants[fvi];
                    break;
                  }
                }
              }
              if (!hasFocusVariant) {
                if (totalFindings < maxFindings) {
                  findings['wcag-focus-indicator'].push({
                    id: nodeId,
                    name: nodeName,
                    issue: 'missing-variant',
                    suggestion: 'Add a focus/focused variant with a visible focus ring or outline'
                  });
                  totalFindings++;
                } else { truncated = true; }
              } else if (focusVariantNode) {
                // Check if focus variant has a visible stroke/border (focus ring)
                var focusStroke = lintGetNodeStrokeColor(focusVariantNode);
                var hasFocusEffect = false;
                try {
                  var effects = focusVariantNode.effects;
                  if (effects) {
                    for (var ei = 0; ei < effects.length; ei++) {
                      if (effects[ei].visible !== false && (effects[ei].type === 'DROP_SHADOW' || effects[ei].type === 'INNER_SHADOW')) {
                        hasFocusEffect = true;
                        break;
                      }
                    }
                  }
                } catch (e) { /* skip */ }
                if (!focusStroke && !hasFocusEffect) {
                  if (totalFindings < maxFindings) {
                    findings['wcag-focus-indicator'].push({
                      id: focusVariantNode.id,
                      name: nodeName + ' / ' + focusVariantNode.name,
                      issue: 'no-visible-indicator',
                      suggestion: 'Focus variant exists but has no visible border, outline, or shadow for the focus indicator'
                    });
                    totalFindings++;
                  } else { truncated = true; }
                }
              }
            }
          } catch (e) { /* slot sublayer */ }
        }

        // wcag-letter-spacing: Negative letter spacing (WCAG 1.4.12)
        if (activeRuleSet['wcag-letter-spacing'] && nodeType === 'TEXT' && !truncated) {
          try {
            var ls = node.letterSpacing;
            if (ls && typeof ls === 'object' && typeof ls.value === 'number') {
              if (ls.unit === 'PIXELS' && ls.value < 0) {
                if (totalFindings < maxFindings) {
                  findings['wcag-letter-spacing'].push({
                    id: nodeId,
                    name: nodeName,
                    letterSpacing: ls.value + 'px'
                  });
                  totalFindings++;
                } else { truncated = true; }
              } else if (ls.unit === 'PERCENT' && ls.value < 0) {
                if (totalFindings < maxFindings) {
                  findings['wcag-letter-spacing'].push({
                    id: nodeId,
                    name: nodeName,
                    letterSpacing: ls.value + '%'
                  });
                  totalFindings++;
                } else { truncated = true; }
              }
            }
          } catch (e) { /* slot sublayer or mixed */ }
        }

        // wcag-paragraph-spacing: Paragraph spacing < 2x font size (WCAG 1.4.12)
        if (activeRuleSet['wcag-paragraph-spacing'] && nodeType === 'TEXT' && !truncated) {
          try {
            var ps = node.paragraphSpacing;
            var psFs = node.fontSize;
            if (typeof ps === 'number' && typeof psFs === 'number' && ps > 0) {
              var requiredPs = 2 * psFs;
              if (ps < requiredPs && textHasMultipleParagraphs(node)) {
                if (totalFindings < maxFindings) {
                  findings['wcag-paragraph-spacing'].push({
                    id: nodeId,
                    name: nodeName,
                    paragraphSpacing: ps,
                    fontSize: psFs,
                    recommended: requiredPs
                  });
                  totalFindings++;
                } else { truncated = true; }
              }
            }
          } catch (e) { /* slot sublayer or mixed */ }
        }

        // wcag-image-alt: Image fills without description (WCAG 1.1.1)
        if (activeRuleSet['wcag-image-alt'] && !isPage && !isSection && !truncated) {
          try {
            var hasImageFill = false;
            var imgFills = node.fills;
            if (imgFills && imgFills.length > 0) {
              for (var ifi = 0; ifi < imgFills.length; ifi++) {
                if (imgFills[ifi].type === 'IMAGE' && imgFills[ifi].visible !== false) {
                  hasImageFill = true;
                  break;
                }
              }
            }
            if (hasImageFill) {
              var hasDescription = false;
              try {
                if (node.description && node.description.trim().length > 0) {
                  hasDescription = true;
                }
              } catch (e) { /* skip */ }
              // Also check if node name indicates decorative
              var isDecorative = false;
              try {
                var lowerName = nodeName.toLowerCase();
                if (lowerName === 'decorative' || lowerName === 'decoration' || lowerName.indexOf('decorative') !== -1) {
                  isDecorative = true;
                }
              } catch (e) { /* skip */ }
              if (!hasDescription && !isDecorative) {
                if (totalFindings < maxFindings) {
                  findings['wcag-image-alt'].push({
                    id: nodeId,
                    name: nodeName,
                    suggestion: 'Add a description in the node\'s description field, or name it "decorative" if purely presentational'
                  });
                  totalFindings++;
                } else { truncated = true; }
              }
            }
          } catch (e) { /* slot sublayer */ }
        }

        // wcag-heading-hierarchy: Track heading levels for hierarchy check (WCAG 1.3.1)
        if (activeRuleSet['wcag-heading-hierarchy'] && nodeType === 'TEXT' && !truncated) {
          try {
            var hlevel = lintGetHeadingLevel(node);
            if (hlevel > 0) {
              headingSequence.push({ level: hlevel, id: nodeId, name: nodeName });
            }
          } catch (e) { /* skip */ }
        }

        // wcag-reflow: Fixed-position frames without auto-layout (WCAG 1.4.10)
        if (activeRuleSet['wcag-reflow'] && !isPage && !isSection && !truncated) {
          try {
            if ((nodeType === 'FRAME' || nodeType === 'COMPONENT') && node.children && node.children.length >= 3) {
              var rlLayoutMode = 'NONE';
              try { rlLayoutMode = node.layoutMode; } catch (e) { /* skip */ }
              if (!rlLayoutMode || rlLayoutMode === 'NONE') {
                // Check if children use absolute positioning (different x/y values)
                var hasAbsoluteChildren = false;
                var childXs = [];
                var childYs = [];
                for (var rci = 0; rci < Math.min(node.children.length, 10); rci++) {
                  try {
                    childXs.push(node.children[rci].x);
                    childYs.push(node.children[rci].y);
                  } catch (e) { /* skip */ }
                }
                if (childXs.length >= 3) {
                  // If children are spread across both axes, it's likely absolute positioning
                  var uniqueXs = [];
                  var uniqueYs = [];
                  for (var uxi = 0; uxi < childXs.length; uxi++) {
                    if (uniqueXs.indexOf(childXs[uxi]) === -1) uniqueXs.push(childXs[uxi]);
                    if (uniqueYs.indexOf(childYs[uxi]) === -1) uniqueYs.push(childYs[uxi]);
                  }
                  hasAbsoluteChildren = uniqueXs.length > 2 && uniqueYs.length > 2;
                }
                if (hasAbsoluteChildren) {
                  if (totalFindings < maxFindings) {
                    findings['wcag-reflow'].push({
                      id: nodeId,
                      name: nodeName,
                      childCount: node.children.length,
                      suggestion: 'Convert to auto-layout so content can reflow at different viewport sizes'
                    });
                    totalFindings++;
                  } else { truncated = true; }
                }
              }
            }
          } catch (e) { /* slot sublayer */ }
        }

        // wcag-reading-order: Check if visual order matches layer order (WCAG 1.3.2)
        if (activeRuleSet['wcag-reading-order'] && !isPage && !isSection && !truncated) {
          try {
            if ((nodeType === 'FRAME' || nodeType === 'COMPONENT' || nodeType === 'INSTANCE') && node.children && node.children.length >= 2) {
              var roLayoutMode = 'NONE';
              try { roLayoutMode = node.layoutMode; } catch (e) { /* skip */ }
              // Only check non-auto-layout frames (auto-layout enforces order)
              if (!roLayoutMode || roLayoutMode === 'NONE') {
                // Collect children y positions (for vertical reading order)
                var childPositions = [];
                var roChildren = node.children;
                for (var roi = 0; roi < roChildren.length; roi++) {
                  try {
                    childPositions.push({
                      index: roi,
                      y: roChildren[roi].y,
                      x: roChildren[roi].x,
                      name: roChildren[roi].name
                    });
                  } catch (e) { /* skip */ }
                }
                if (childPositions.length >= 2) {
                  // Sort by visual position (top-to-bottom, left-to-right)
                  var visualOrder = childPositions.slice().sort(function(a, b) {
                    if (Math.abs(a.y - b.y) > 10) return a.y - b.y; // Different row
                    return a.x - b.x; // Same row, left to right
                  });
                  // Check if layer order matches visual order
                  var orderMismatches = 0;
                  for (var omi = 0; omi < visualOrder.length; omi++) {
                    if (visualOrder[omi].index !== omi) {
                      orderMismatches++;
                    }
                  }
                  // Flag if more than 30% of elements are out of order
                  if (orderMismatches > childPositions.length * 0.3 && orderMismatches >= 2) {
                    if (totalFindings < maxFindings) {
                      findings['wcag-reading-order'].push({
                        id: nodeId,
                        name: nodeName,
                        childCount: childPositions.length,
                        mismatches: orderMismatches,
                        suggestion: 'Reorder layers to match visual top-to-bottom, left-to-right reading order'
                      });
                      totalFindings++;
                    } else { truncated = true; }
                  }
                }
              }
            }
          } catch (e) { /* slot sublayer */ }
        }

        // wcag-disabled-no-context: Disabled variant without tooltip/helper text (Isabella's pattern)
        if (activeRuleSet['wcag-disabled-no-context'] && nodeType === 'COMPONENT_SET' && !truncated) {
          try {
            var csChildren = node.children;
            if (csChildren) {
              for (var dci = 0; dci < csChildren.length && !truncated; dci++) {
                var dcVariant = csChildren[dci];
                try {
                  var dcName = dcVariant.name || '';
                  if (/(disabled|inactive)/i.test(dcName)) {
                    // Check if disabled variant has tooltip, helper text, or descriptive child
                    var hasContextChild = false;
                    try {
                      if (dcVariant.children) {
                        for (var dcci = 0; dcci < dcVariant.children.length; dcci++) {
                          var dcChild = dcVariant.children[dcci];
                          try {
                            var dcChildName = (dcChild.name || '').toLowerCase();
                            // Look for tooltip, helper text, hint, description, or error message children
                            if (/tooltip|helper|hint|description|message|caption|note|info|why|reason/i.test(dcChildName)) {
                              hasContextChild = true;
                              break;
                            }
                            // Recurse one level for nested tooltip/helper
                            if (dcChild.children) {
                              for (var dcgci = 0; dcgci < dcChild.children.length; dcgci++) {
                                var dcGrandchild = dcChild.children[dcgci];
                                try {
                                  if (/tooltip|helper|hint|description|message/i.test(dcGrandchild.name || '')) {
                                    hasContextChild = true;
                                    break;
                                  }
                                } catch (e) { /* skip */ }
                              }
                              if (hasContextChild) break;
                            }
                          } catch (e) { /* skip */ }
                        }
                      }
                    } catch (e) { /* skip */ }
                    // Also check component description for disabled guidance
                    var hasDisabledAnnotation = false;
                    try {
                      var csDesc = (node.description || '').toLowerCase();
                      if (/disabled.*tooltip|disabled.*helper|disabled.*hint|aria-disabled|why.*disabled|disabled.*reason/i.test(csDesc)) {
                        hasDisabledAnnotation = true;
                      }
                    } catch (e) { /* skip */ }
                    if (!hasContextChild && !hasDisabledAnnotation) {
                      if (totalFindings < maxFindings) {
                        findings['wcag-disabled-no-context'].push({
                          id: dcVariant.id,
                          name: nodeName + ' / ' + dcVariant.name,
                          suggestion: 'Disabled elements should remain focusable (use aria-disabled, not HTML disabled). Add a tooltip or helper text explaining why the element is disabled so screen reader users understand the context.'
                        });
                        totalFindings++;
                      } else { truncated = true; }
                    }
                  }
                } catch (e) { /* skip variant */ }
              }
            }
          } catch (e) { /* slot sublayer */ }
        }

        // ---- Design System checks ----

        // token-misuse: Variable name prefix doesn't match usage context
        if (activeRuleSet['token-misuse'] && !isPage && !isSection && !truncated) {
          try {
            var tmFills = node.fills;
            if (tmFills && tmFills.length > 0) {
              for (var tmi = 0; tmi < tmFills.length; tmi++) {
                var tmFill = tmFills[tmi];
                if (tmFill.type === 'SOLID' && tmFill.visible !== false) {
                  try {
                    if (tmFill.boundVariables && tmFill.boundVariables.color) {
                      var tmVarId = tmFill.boundVariables.color.id;
                      // Resolve variable name
                      try {
                        var tmVar = variableNames[tmVarId] ? { name: variableNames[tmVarId] } : null;
                        if (tmVar) {
                          var tmVarName = tmVar.name.toLowerCase();
                          var isBgToken = /^(bg|background|surface|fill)[\/-]/.test(tmVarName);
                          var isTextNode = nodeType === 'TEXT';
                          // Flag: bg/surface token used as text fill
                          if (isTextNode && isBgToken) {
                            if (totalFindings < maxFindings) {
                              findings['token-misuse'].push({
                                id: nodeId,
                                name: nodeName,
                                variable: tmVar.name,
                                usage: 'text fill',
                                expectedPrefix: 'text/*, fg/*, foreground/*',
                                suggestion: 'This text node uses a background/surface token ("' + tmVar.name + '") as its fill color. This is likely a misbound token — use a text/foreground token instead.'
                              });
                              totalFindings++;
                            } else { truncated = true; }
                          }
                          // Flag: text/foreground token used as frame/shape background
                          var isTextToken = /^(text|fg|foreground|font)[\/-]/.test(tmVarName);
                          var isContainerNode = nodeType === 'FRAME' || nodeType === 'COMPONENT' || nodeType === 'INSTANCE' || nodeType === 'RECTANGLE';
                          if (isContainerNode && isTextToken && !truncated) {
                            if (totalFindings < maxFindings) {
                              findings['token-misuse'].push({
                                id: nodeId,
                                name: nodeName,
                                variable: tmVar.name,
                                usage: 'background fill',
                                expectedPrefix: 'bg/*, background/*, surface/*',
                                suggestion: 'This container uses a text/foreground token ("' + tmVar.name + '") as its background fill. This is likely a misbound token — use a background/surface token instead.'
                              });
                              totalFindings++;
                            } else { truncated = true; }
                          }
                        }
                      } catch (e) { /* can't resolve variable */ }
                    }
                  } catch (e) { /* no bound vars */ }
                }
              }
            }
          } catch (e) { /* slot sublayer */ }
        }

        // hardcoded-color: Solid fills without variable binding or style
        if (activeRuleSet['hardcoded-color'] && !isPage && !isSection && !truncated) {
          try {
            var hcFills = node.fills;
            if (hcFills && hcFills.length > 0) {
              var hasFillStyle = false;
              try {
                hasFillStyle = node.fillStyleId && node.fillStyleId !== '';
              } catch (e) { /* mixed fill styles */ }

              if (!hasFillStyle) {
                for (var hci = 0; hci < hcFills.length; hci++) {
                  var hcFill = hcFills[hci];
                  if (hcFill.type === 'SOLID' && hcFill.visible !== false) {
                    var hasBoundVar = false;
                    try {
                      if (hcFill.boundVariables && hcFill.boundVariables.color) {
                        hasBoundVar = true;
                      }
                    } catch (e) { /* no bound vars */ }

                    if (!hasBoundVar) {
                      if (totalFindings < maxFindings) {
                        findings['hardcoded-color'].push({
                          id: nodeId,
                          name: nodeName,
                          color: lintRgbToHex(hcFill.color.r, hcFill.color.g, hcFill.color.b)
                        });
                        totalFindings++;
                      } else {
                        truncated = true;
                      }
                      break; // One finding per node
                    }
                  }
                }
              }
            }
          } catch (e) { /* slot sublayer */ }
        }

        // no-text-style: TEXT nodes without textStyleId
        if (activeRuleSet['no-text-style'] && nodeType === 'TEXT' && !truncated) {
          try {
            var hasTextStyle = node.textStyleId && node.textStyleId !== '';
            if (!hasTextStyle) {
              if (totalFindings < maxFindings) {
                findings['no-text-style'].push({
                  id: nodeId,
                  name: nodeName
                });
                totalFindings++;
              } else {
                truncated = true;
              }
            }
          } catch (e) { /* slot sublayer or mixed */ }
        }

        // default-name: Nodes with default Figma names
        if (activeRuleSet['default-name'] && !isPage && !truncated) {
          try {
            if (defaultNameRegex.test(nodeName)) {
              if (totalFindings < maxFindings) {
                findings['default-name'].push({
                  id: nodeId,
                  name: nodeName,
                  type: nodeType
                });
                totalFindings++;
              } else {
                truncated = true;
              }
            }
          } catch (e) { /* slot sublayer */ }
        }

        // detached-component: Frames with "/" in name but not component/instance
        if (activeRuleSet['detached-component'] && nodeType === 'FRAME' && !truncated) {
          try {
            if (nodeName.indexOf('/') !== -1) {
              if (totalFindings < maxFindings) {
                findings['detached-component'].push({
                  id: nodeId,
                  name: nodeName
                });
                totalFindings++;
              } else {
                truncated = true;
              }
            }
          } catch (e) { /* slot sublayer */ }
        }

        // ---- Layout checks ----

        // no-autolayout: Frames with 2+ children and no auto-layout
        if (activeRuleSet['no-autolayout'] && !isPage && !isSection && !truncated) {
          try {
            if (nodeType === 'FRAME' || nodeType === 'COMPONENT' || nodeType === 'COMPONENT_SET') {
              var childCount = 0;
              try { childCount = node.children ? node.children.length : 0; } catch (e) { /* skip */ }
              if (childCount >= 2) {
                var layoutMode = 'NONE';
                try { layoutMode = node.layoutMode; } catch (e) { /* skip */ }
                if (!layoutMode || layoutMode === 'NONE') {
                  if (totalFindings < maxFindings) {
                    findings['no-autolayout'].push({
                      id: nodeId,
                      name: nodeName,
                      childCount: childCount
                    });
                    totalFindings++;
                  } else {
                    truncated = true;
                  }
                }
              }
            }
          } catch (e) { /* slot sublayer */ }
        }

        // empty-container: Frames with zero children
        if (activeRuleSet['empty-container'] && !isPage && !isSection && !truncated) {
          try {
            if (nodeType === 'FRAME') {
              var ec = 0;
              try { ec = node.children ? node.children.length : 0; } catch (e) { /* skip */ }
              if (ec === 0) {
                if (totalFindings < maxFindings) {
                  findings['empty-container'].push({
                    id: nodeId,
                    name: nodeName
                  });
                  totalFindings++;
                } else {
                  truncated = true;
                }
              }
            }
          } catch (e) { /* slot sublayer */ }
        }

        // ---- Recurse into children ----
        try {
          var walkChildren = node.children;
          if (walkChildren) {
            for (var ci = 0; ci < walkChildren.length; ci++) {
              if (truncated) break;
              await walkNode(walkChildren[ci], depth + 1);
            }
          }
        } catch (e) { /* no children or slot sublayer */ }
      }

      // ---- Execute walk ----
      await walkNode(rootNode, 0);

      // ---- Post-walk: heading hierarchy validation ----
      if (activeRuleSet['wcag-heading-hierarchy'] && headingSequence.length >= 2 && !truncated) {
        var prevLevel = 0;
        for (var hi = 0; hi < headingSequence.length; hi++) {
          var h = headingSequence[hi];
          if (prevLevel > 0 && h.level > prevLevel + 1) {
            // Skipped a level (e.g., H1 → H3)
            if (totalFindings < maxFindings) {
              findings['wcag-heading-hierarchy'].push({
                id: h.id,
                name: h.name,
                level: h.level,
                previousLevel: prevLevel,
                suggestion: 'Expected H' + (prevLevel + 1) + ' but found H' + h.level + '. Do not skip heading levels.'
              });
              totalFindings++;
            } else {
              truncated = true;
              break;
            }
          }
          prevLevel = h.level;
        }
      }

      // ---- Build response ----
      var categories = [];
      var summaryObj = { critical: 0, warning: 0, info: 0, total: 0 };

      for (var rk = 0; rk < allRuleIds.length; rk++) {
        var ruleId = allRuleIds[rk];
        if (!findings[ruleId] || findings[ruleId].length === 0) continue;
        var sev = severityMap[ruleId];
        categories.push({
          rule: ruleId,
          severity: sev,
          wcagLevel: wcagLevelMap[ruleId] || null,
          count: findings[ruleId].length,
          description: ruleDescriptions[ruleId],
          nodes: findings[ruleId]
        });
        summaryObj[sev] = (summaryObj[sev] || 0) + findings[ruleId].length;
        summaryObj.total += findings[ruleId].length;
      }

      var responseData = {
        rootNodeId: rootNode.id,
        rootNodeName: rootNode.name,
        nodesScanned: nodesScanned,
        categories: categories,
        summary: summaryObj
      };

      if (timedOut) {
        responseData.warning = 'Stopped after ' + Math.round(timeLimitMs / 1000) + ' s, after ' + nodesScanned + ' layers. Check a smaller part, such as one frame.';
      } else if (truncated) {
        responseData.warning = 'Showing first ' + maxFindings + ' findings...';
      }

      return responseData;
}

export async function auditComponentAccessibility(msg) {

      // ---- Color science helpers (shared with lint) ----
      function auditLinearize(c) {
        return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
      }
      function auditLuminance(r, g, b) {
        return 0.2126 * auditLinearize(r) + 0.7152 * auditLinearize(g) + 0.0722 * auditLinearize(b);
      }
      function auditContrastRatio(r1, g1, b1, r2, g2, b2) {
        var l1 = auditLuminance(r1, g1, b1);
        var l2 = auditLuminance(r2, g2, b2);
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      }
      function auditRgbToHex(r, g, b) {
        var rr = Math.round(r * 255).toString(16);
        var gg = Math.round(g * 255).toString(16);
        var bb = Math.round(b * 255).toString(16);
        if (rr.length === 1) rr = '0' + rr;
        if (gg.length === 1) gg = '0' + gg;
        if (bb.length === 1) bb = '0' + bb;
        return '#' + rr.toUpperCase() + gg.toUpperCase() + bb.toUpperCase();
      }

      // ---- Color-blind simulation matrices ----
      // Brettel/Vienot transformation matrices for dichromatic vision
      var colorBlindMatrices = {
        protanopia: [
          [0.152286, 1.052583, -0.204868],
          [0.114503, 0.786281, 0.099216],
          [-0.003882, -0.048116, 1.051998]
        ],
        deuteranopia: [
          [0.367322, 0.860646, -0.227968],
          [0.280085, 0.672501, 0.047413],
          [-0.011820, 0.042940, 0.968881]
        ],
        tritanopia: [
          [1.255528, -0.076749, -0.178779],
          [-0.078411, 0.930809, 0.147602],
          [0.004733, 0.691367, 0.303900]
        ]
      };

      function simulateColorBlind(r, g, b, matrix) {
        var nr = Math.max(0, Math.min(1, matrix[0][0] * r + matrix[0][1] * g + matrix[0][2] * b));
        var ng = Math.max(0, Math.min(1, matrix[1][0] * r + matrix[1][1] * g + matrix[1][2] * b));
        var nb = Math.max(0, Math.min(1, matrix[2][0] * r + matrix[2][1] * g + matrix[2][2] * b));
        return { r: nr, g: ng, b: nb };
      }

      // ---- Node inspection helpers ----
      function auditGetFillColor(node) {
        try {
          var fills = node.fills;
          if (fills && fills.length > 0) {
            for (var i = fills.length - 1; i >= 0; i--) {
              if (fills[i].type === 'SOLID' && fills[i].visible !== false) {
                return { r: fills[i].color.r, g: fills[i].color.g, b: fills[i].color.b, opacity: fills[i].opacity };
              }
            }
          }
        } catch (e) { /* skip */ }
        return null;
      }

      function auditGetStrokeColor(node) {
        try {
          var strokes = node.strokes;
          if (strokes && strokes.length > 0) {
            for (var i = strokes.length - 1; i >= 0; i--) {
              if (strokes[i].type === 'SOLID' && strokes[i].visible !== false) {
                return { r: strokes[i].color.r, g: strokes[i].color.g, b: strokes[i].color.b, opacity: strokes[i].opacity };
              }
            }
          }
        } catch (e) { /* skip */ }
        return null;
      }

      function auditGetEffectiveBg(node) {
        var current = node.parent;
        while (current) {
          try {
            if (current.fills && current.fills.length > 0) {
              for (var fi = current.fills.length - 1; fi >= 0; fi--) {
                var fill = current.fills[fi];
                if (fill.type === 'SOLID' && fill.visible !== false) {
                  return { r: fill.color.r, g: fill.color.g, b: fill.color.b, opacity: fill.opacity };
                }
              }
            }
          } catch (e) { /* skip */ }
          current = current.parent;
        }
        return { r: 1, g: 1, b: 1 };
      }

      // FigPal: the background that shows under a node.
      function auditShownBg(node) {
        var fill = auditGetEffectiveBg(node);
        return blend(fill, WHITE, fill.opacity);
      }

      function auditHasChildOfType(node, types) {
        try {
          if (!node.children) return false;
          for (var i = 0; i < node.children.length; i++) {
            var child = node.children[i];
            try {
              for (var t = 0; t < types.length; t++) {
                if (child.type === types[t]) return true;
              }
              // Recurse one level deeper for nested icons
              if (child.children) {
                for (var j = 0; j < child.children.length; j++) {
                  try {
                    for (var t2 = 0; t2 < types.length; t2++) {
                      if (child.children[j].type === types[t2]) return true;
                    }
                  } catch (e) { /* skip */ }
                }
              }
            } catch (e) { /* skip */ }
          }
        } catch (e) { /* skip */ }
        return false;
      }

      // Collect the first 20 text/background color pairs that the simulations use.
      function auditCollectColorPairs(node, pairs, depth) {
        if (depth > 5 || pairs.length >= 20) return;
        try {
          if (node.type === 'TEXT') {
            var fills = node.fills;
            if (fills && fills.length > 0) {
              for (var i = 0; i < fills.length; i++) {
                if (fills[i].type === 'SOLID' && fills[i].visible !== false) {
                  var bg = auditShownBg(node);
                  pairs.push({
                    fg: blend(fills[i].color, bg, fills[i].opacity),
                    bg: bg,
                    nodeName: node.name,
                    nodeId: node.id
                  });
                  break;
                }
              }
            }
          }
          if (node.children) {
            for (var ci = 0; ci < node.children.length && pairs.length < 20; ci++) {
              auditCollectColorPairs(node.children[ci], pairs, depth + 1);
            }
          }
        } catch (e) { /* skip */ }
      }

      // ---- Resolve target node ----
      var targetNode;
      if (msg.nodeId) {
        targetNode = await figma.getNodeByIdAsync(msg.nodeId);
        if (!targetNode) {
          throw new Error('Node not found: ' + msg.nodeId);
        }
      } else {
        // Try current selection
        var sel = figma.currentPage.selection;
        if (sel && sel.length === 1) {
          targetNode = sel[0];
        } else {
          throw new Error('No nodeId provided and no single node selected. Select a component set or provide a nodeId.');
        }
      }

      // If user selected a COMPONENT or INSTANCE, walk up to the COMPONENT_SET
      var componentSet = targetNode;
      if (targetNode.type === 'COMPONENT' && targetNode.parent && targetNode.parent.type === 'COMPONENT_SET') {
        componentSet = targetNode.parent;
      } else if (targetNode.type === 'INSTANCE') {
        try {
          var mainComponent = await targetNode.getMainComponentAsync();
          if (mainComponent && mainComponent.parent && mainComponent.parent.type === 'COMPONENT_SET') {
            componentSet = mainComponent.parent;
          } else if (mainComponent && mainComponent.type === 'COMPONENT') {
            componentSet = mainComponent;
          }
        } catch (e) { /* use target as-is */ }
      }

      var isComponentSet = componentSet.type === 'COMPONENT_SET';
      var isComponent = componentSet.type === 'COMPONENT';
      if (!isComponentSet && !isComponent) {
        throw new Error('Node "' + componentSet.name + '" is type ' + componentSet.type + '. Expected COMPONENT_SET or COMPONENT.');
      }

      // ---- Analyze variants ----
      var variants = isComponentSet ? componentSet.children : [componentSet];
      var variantCount = variants.length;

      // ---- Classify component as interactive vs presentational ----
      var interactiveNames = /^(button|link|input|checkbox|radio|switch|toggle|tab|select|slider|dropdown|menu-item|search|combobox|listbox)/i;
      var presentationalNames = /^(alert|badge|card|avatar|divider|skeleton|tooltip|tag|chip|banner|callout|notification|toast|icon|image|separator|progress|spinner|loader|breadcrumb|label|heading|paragraph|caption|stat|meter|indicator)/i;

      // Parse variant axes from variant names (e.g., "type=success, style=fill" → {type: [...], style: [...]})
      var variantAxes = {};
      var hasStateAxis = false;
      for (var vai = 0; vai < variants.length; vai++) {
        var vParts = variants[vai].name.split(',');
        for (var vpi = 0; vpi < vParts.length; vpi++) {
          var kv = vParts[vpi].trim().split('=');
          if (kv.length === 2) {
            var axisName = kv[0].trim().toLowerCase();
            var axisValue = kv[1].trim().toLowerCase();
            if (!variantAxes[axisName]) variantAxes[axisName] = [];
            if (variantAxes[axisName].indexOf(axisValue) === -1) {
              variantAxes[axisName].push(axisValue);
            }
            // Check if this axis contains interaction state values
            if (STATE_AXES.indexOf(axisName) !== -1 && /\b(hover|focus|pressed|disabled|active)/i.test(axisValue)) {
              hasStateAxis = true;
            }
          }
        }
      }

      // The last part of a name such as "Controls/Button".
      var componentName = (componentSet.name || '').split('/').pop().trim();
      var isInteractive = interactiveNames.test(componentName) || (hasStateAxis && !presentationalNames.test(componentName));
      var isPresentational = !isInteractive;

      // 1. Coverage analysis — adapts to component classification
      var stateKeywords = {
        'default': /(default|rest|idle|normal|base)/i,
        'hover': /(hover|hovered)/i,
        'focus': /(focus|focused)/i,
        'disabled': /(disabled|inactive)/i,
        'error': /(error|invalid|danger)/i,
        'active': /(active|pressed|selected)/i,
        'loading': /(loading|spinner)/i
      };

      var coveredCount = 0;
      var totalStates = 0;
      var missingStates = [];
      var statesCovered = {};
      var statesFound = {};
      var coverageLabel = '';
      var variantAxisCoverage = null;

      if (isInteractive) {
        // Interactive components: check for interaction states
        coverageLabel = 'interactive-states';
        for (var sk in stateKeywords) {
          statesCovered[sk] = false;
          statesFound[sk] = null;
        }
        for (var vi = 0; vi < variants.length; vi++) {
          var vName = variants[vi].name;
          for (var sk2 in stateKeywords) {
            if (stateKeywords[sk2].test(vName)) {
              statesCovered[sk2] = true;
              if (!statesFound[sk2]) statesFound[sk2] = vName;
            }
          }
        }
        if (variantCount === 1 && !statesCovered['default']) {
          statesCovered['default'] = true;
          statesFound['default'] = variants[0].name;
        }
        for (var sk3 in statesCovered) {
          totalStates++;
          if (statesCovered[sk3]) {
            coveredCount++;
          } else {
            missingStates.push(sk3);
          }
        }
      } else {
        // Presentational components: check variant axis completeness
        coverageLabel = 'variant-axes';
        // Calculate expected combinations vs actual
        var axisNames = [];
        var axisCounts = [];
        var expectedCombinations = 1;
        for (var axName in variantAxes) {
          axisNames.push(axName);
          axisCounts.push(variantAxes[axName].length);
          expectedCombinations *= variantAxes[axName].length;
        }
        // Score: actual variants / expected combinations (capped at 100%)
        var axisCoverageRatio = expectedCombinations > 0 ? Math.min(1, variantCount / expectedCombinations) : 1;
        coveredCount = variantCount;
        totalStates = expectedCombinations;
        variantAxisCoverage = {
          axes: variantAxes,
          axisCount: axisNames.length,
          expectedCombinations: expectedCombinations,
          actualVariants: variantCount,
          completeness: Math.round(axisCoverageRatio * 100) + '%'
        };
        // For presentational, no "missing states" — instead note if combinations are incomplete
        if (variantCount < expectedCombinations) {
          missingStates.push(variantCount + '/' + expectedCombinations + ' axis combinations present');
        }
      }

      // 2. Focus indicator quality
      var focusAnalysis = { hasVariant: false, hasVisibleIndicator: false, contrastRatio: null, details: '' };
      if (statesCovered['focus'] && isComponentSet) {
        focusAnalysis.hasVariant = true;
        for (var fvi = 0; fvi < variants.length; fvi++) {
          if (/(focus|focused)/i.test(variants[fvi].name)) {
            var focusNode = variants[fvi];
            // Check for stroke (focus ring)
            var fStroke = auditGetStrokeColor(focusNode);
            if (fStroke) {
              var fBg = auditShownBg(focusNode);
              fStroke = blend(fStroke, fBg, fStroke.opacity);
              var fRatio = auditContrastRatio(fStroke.r, fStroke.g, fStroke.b, fBg.r, fBg.g, fBg.b);
              focusAnalysis.hasVisibleIndicator = true;
              focusAnalysis.contrastRatio = parseFloat(fRatio.toFixed(1));
              focusAnalysis.details = 'Focus ring (stroke) with ' + fRatio.toFixed(1) + ':1 contrast';
              break;
            }
            // Check for shadow effect
            try {
              var effects = focusNode.effects;
              if (effects) {
                for (var ei = 0; ei < effects.length; ei++) {
                  if (effects[ei].visible !== false && (effects[ei].type === 'DROP_SHADOW' || effects[ei].type === 'INNER_SHADOW')) {
                    focusAnalysis.hasVisibleIndicator = true;
                    focusAnalysis.details = 'Focus indicator via ' + effects[ei].type.toLowerCase().replace('_', ' ');
                    break;
                  }
                }
              }
            } catch (e) { /* skip */ }
            if (!focusAnalysis.hasVisibleIndicator) {
              focusAnalysis.details = 'Focus variant exists but no visible stroke or shadow detected';
            }
            break;
          }
        }
      } else if (!statesCovered['focus']) {
        focusAnalysis.details = 'No focus/focused variant found';
      }

      // 3. Non-color differentiation for status states
      var colorDifferentiation = { issues: [], checked: 0 };
      if (isComponentSet) {
        var statusStates = ['error', 'disabled', 'active'];
        var defaultVariant = findDefaultVariant(componentSet);
        for (var ssi = 0; ssi < statusStates.length; ssi++) {
          var stateName = statusStates[ssi];
          if (statesCovered[stateName]) {
            colorDifferentiation.checked++;
            for (var svi = 0; svi < variants.length; svi++) {
              if (stateKeywords[stateName].test(variants[svi].name)) {
                var stateVariant = variants[svi];
                var stateFill = auditGetFillColor(stateVariant);
                var defaultFill = defaultVariant ? auditGetFillColor(defaultVariant) : null;
                var hasIcon = auditHasChildOfType(stateVariant, ['VECTOR', 'BOOLEAN_OPERATION', 'INSTANCE']);
                var hasStroke = auditGetStrokeColor(stateVariant) !== null;
                var colorDiffers = stateFill && defaultFill && (stateFill.r !== defaultFill.r || stateFill.g !== defaultFill.g || stateFill.b !== defaultFill.b);
                if (colorDiffers && !hasIcon && !hasStroke) {
                  colorDifferentiation.issues.push({
                    variant: stateVariant.name,
                    state: stateName,
                    variantColor: stateFill ? auditRgbToHex(stateFill.r, stateFill.g, stateFill.b) : null,
                    defaultColor: defaultFill ? auditRgbToHex(defaultFill.r, defaultFill.g, defaultFill.b) : null,
                    suggestion: 'Add icon, border, or text indicator beyond color'
                  });
                }
                break;
              }
            }
          }
        }
      }

      // 4. Target size analysis
      // WCAG 2.5.8 applies to interactive targets — presentational components
      // (badges, avatars, progress bars) are not tap targets by definition.
      // Skip target size checking for presentational components to avoid false positives.
      var targetSizeAnalysis = { minWidth: Infinity, minHeight: Infinity, variants: [], issues: [] };
      var minTarget = msg.targetSize || 24; // Default WCAG 2.5.8 minimum
      for (var tvi = 0; tvi < variants.length; tvi++) {
        try {
          var tw = variants[tvi].width;
          var th = variants[tvi].height;
          if (typeof tw === 'number' && typeof th === 'number') {
            targetSizeAnalysis.variants.push({ name: variants[tvi].name, width: tw, height: th });
            if (tw < targetSizeAnalysis.minWidth) targetSizeAnalysis.minWidth = tw;
            if (th < targetSizeAnalysis.minHeight) targetSizeAnalysis.minHeight = th;
            // Only flag target size issues for interactive components
            if (isInteractive && (tw < minTarget || th < minTarget)) {
              targetSizeAnalysis.issues.push({
                variant: variants[tvi].name,
                width: tw,
                height: th,
                required: minTarget + 'x' + minTarget
              });
            }
          }
        } catch (e) { /* skip */ }
      }
      if (targetSizeAnalysis.minWidth === Infinity) targetSizeAnalysis.minWidth = null;
      if (targetSizeAnalysis.minHeight === Infinity) targetSizeAnalysis.minHeight = null;

      // 5. Annotation completeness
      var annotations = { hasDescription: false, description: '', hasA11yNotes: false, a11yNotes: '' };
      try {
        var desc = componentSet.description || '';
        if (desc.trim().length > 0) {
          annotations.hasDescription = true;
          annotations.description = desc.substring(0, 200);
        }
        if (/aria|accessibility|a11y|screen.?reader|keyboard|role|tab.?order/i.test(desc)) {
          annotations.hasA11yNotes = true;
          // Extract just the a11y-relevant section
          var lines = desc.split('\n');
          var a11yLines = [];
          for (var ali = 0; ali < lines.length; ali++) {
            if (/aria|accessibility|a11y|screen.?reader|keyboard|role|tab.?order/i.test(lines[ali])) {
              a11yLines.push(lines[ali].trim());
            }
          }
          annotations.a11yNotes = a11yLines.join('; ').substring(0, 300);
        }
      } catch (e) { /* skip */ }

      // 6. Color-blind simulation
      var colorBlindAnalysis = { simulations: [], issues: [] };
      // Collect all text/bg color pairs from the default variant (or first variant)
      var sampleVariant = defaultVariant || variants[0];
      var colorPairs = [];
      auditCollectColorPairs(sampleVariant, colorPairs, 0);

      // Also check component fill against its background
      var compFill = auditGetFillColor(sampleVariant);
      var compBg = auditShownBg(sampleVariant);
      if (compFill) {
        colorPairs.push({ fg: blend(compFill, compBg, compFill.opacity), bg: compBg, nodeName: sampleVariant.name + ' (fill)', nodeId: sampleVariant.id });
      }

      var cbTypes = ['protanopia', 'deuteranopia', 'tritanopia'];
      for (var cbi = 0; cbi < cbTypes.length; cbi++) {
        var cbType = cbTypes[cbi];
        var matrix = colorBlindMatrices[cbType];
        var failingPairs = [];
        for (var cpi = 0; cpi < Math.min(colorPairs.length, 20); cpi++) {
          var pair = colorPairs[cpi];
          var simFg = simulateColorBlind(pair.fg.r, pair.fg.g, pair.fg.b, matrix);
          var simBg = simulateColorBlind(pair.bg.r, pair.bg.g, pair.bg.b, matrix);
          var originalRatio = auditContrastRatio(pair.fg.r, pair.fg.g, pair.fg.b, pair.bg.r, pair.bg.g, pair.bg.b);
          var simRatio = auditContrastRatio(simFg.r, simFg.g, simFg.b, simBg.r, simBg.g, simBg.b);
          // Flag if simulated contrast drops below 4.5:1 (AA) when original was passing
          if (originalRatio >= 4.5 && simRatio < 4.5) {
            failingPairs.push({
              nodeName: pair.nodeName,
              originalRatio: parseFloat(originalRatio.toFixed(1)),
              simulatedRatio: parseFloat(simRatio.toFixed(1)),
              originalFg: auditRgbToHex(pair.fg.r, pair.fg.g, pair.fg.b),
              simulatedFg: auditRgbToHex(simFg.r, simFg.g, simFg.b)
            });
          }
          // Also flag if contrast drops significantly (>30% reduction) even if still passing
          if (originalRatio >= 4.5 && simRatio >= 4.5 && (simRatio / originalRatio) < 0.7) {
            failingPairs.push({
              nodeName: pair.nodeName,
              originalRatio: parseFloat(originalRatio.toFixed(1)),
              simulatedRatio: parseFloat(simRatio.toFixed(1)),
              originalFg: auditRgbToHex(pair.fg.r, pair.fg.g, pair.fg.b),
              simulatedFg: auditRgbToHex(simFg.r, simFg.g, simFg.b),
              note: 'Significant contrast reduction (>30%)'
            });
          }
        }
        colorBlindAnalysis.simulations.push({
          type: cbType,
          pairsChecked: Math.min(colorPairs.length, 20),
          issues: failingPairs.length,
          details: failingPairs
        });
        if (failingPairs.length > 0) {
          colorBlindAnalysis.issues.push(cbType + ': ' + failingPairs.length + ' color pair(s) lose sufficient contrast');
        }
      }

      // ---- Compute overall score ----
      var scores = {};
      // Coverage: percentage of states (interactive) or axis combinations (presentational)
      scores.variantCoverage = totalStates > 0 ? Math.round((coveredCount / totalStates) * 100) : 100;
      // Focus indicator: 0 (missing), 50 (exists but no indicator), 100 (good indicator)
      // For presentational: N/A → score 100 (don't penalize)
      scores.focusIndicator = isPresentational ? 100 : (!focusAnalysis.hasVariant ? 0 : (!focusAnalysis.hasVisibleIndicator ? 50 : 100));
      // Color differentiation: 100 if no issues, decremented per issue
      scores.colorDifferentiation = colorDifferentiation.checked === 0 ? 100 : Math.max(0, Math.round(((colorDifferentiation.checked - colorDifferentiation.issues.length) / colorDifferentiation.checked) * 100));
      // Target size: N/A for presentational (not tap targets), scored for interactive
      scores.targetSize = isPresentational ? 100 : (targetSizeAnalysis.issues.length === 0 ? 100 : Math.max(0, Math.round(((targetSizeAnalysis.variants.length - targetSizeAnalysis.issues.length) / Math.max(1, targetSizeAnalysis.variants.length)) * 100)));
      // Annotations: 0 (nothing), 50 (description only), 100 (has a11y notes)
      scores.annotations = annotations.hasA11yNotes ? 100 : (annotations.hasDescription ? 50 : 0);
      // Color blind: percentage of simulations with no issues
      var cbPassCount = 0;
      for (var cbsi = 0; cbsi < colorBlindAnalysis.simulations.length; cbsi++) {
        if (colorBlindAnalysis.simulations[cbsi].issues === 0) cbPassCount++;
      }
      scores.colorBlindSafety = colorBlindAnalysis.simulations.length > 0 ? Math.round((cbPassCount / colorBlindAnalysis.simulations.length) * 100) : 100;

      // Overall weighted score — weights differ by component classification
      var overall;
      if (isInteractive) {
        // Interactive: focus and states matter most
        overall = Math.round(
          scores.variantCoverage * 0.20 +
          scores.focusIndicator * 0.20 +
          scores.colorDifferentiation * 0.15 +
          scores.targetSize * 0.15 +
          scores.annotations * 0.10 +
          scores.colorBlindSafety * 0.20
        );
      } else {
        // Presentational: variant completeness and color safety matter most, focus is N/A
        overall = Math.round(
          scores.variantCoverage * 0.25 +
          scores.colorDifferentiation * 0.25 +
          scores.annotations * 0.15 +
          scores.colorBlindSafety * 0.25 +
          scores.targetSize * 0.10
        );
      }

      // ---- Build response ----
      var coverageSection;
      if (isInteractive) {
        coverageSection = {
          mode: 'interactive-states',
          found: statesFound,
          missing: missingStates,
          coverage: coveredCount + '/' + totalStates
        };
      } else {
        coverageSection = {
          mode: 'variant-axes',
          axes: variantAxisCoverage,
          coverage: coveredCount + '/' + totalStates
        };
      }

      var auditResult = {
        component: {
          id: componentSet.id,
          name: componentSet.name,
          type: componentSet.type,
          variantCount: variantCount,
          classification: isInteractive ? 'interactive' : 'presentational'
        },
        overallScore: overall,
        scores: scores,
        variantCoverage: coverageSection,
        focusIndicator: isInteractive ? focusAnalysis : { notApplicable: true, details: 'Focus indicators are not expected for presentational components' },
        colorDifferentiation: colorDifferentiation,
        targetSize: isInteractive ? {
          minimum: minTarget + 'x' + minTarget,
          smallest: targetSizeAnalysis.minWidth + 'x' + targetSizeAnalysis.minHeight,
          issues: targetSizeAnalysis.issues
        } : { notApplicable: true, details: 'Target size checks apply to interactive components (WCAG 2.5.8 is about tap targets)', smallest: targetSizeAnalysis.minWidth + 'x' + targetSizeAnalysis.minHeight },
        annotations: annotations,
        colorBlindSimulation: colorBlindAnalysis,
        recommendations: []
      };

      // Generate recommendations — classification-aware
      if (isInteractive) {
        if (!focusAnalysis.hasVariant) {
          auditResult.recommendations.push({ priority: 'high', area: 'focus', message: 'Add a focus/focused variant with a visible focus ring (WCAG 2.4.7)' });
        } else if (!focusAnalysis.hasVisibleIndicator) {
          auditResult.recommendations.push({ priority: 'medium', area: 'focus', message: 'Focus variant exists but lacks visible indicator — add a border or shadow' });
        }
      }
      if (colorDifferentiation.issues.length > 0) {
        auditResult.recommendations.push({ priority: 'high', area: 'color', message: 'Add non-color indicators (icons, borders, text) to ' + colorDifferentiation.issues.length + ' state variant(s) (WCAG 1.4.1)' });
      }
      if (targetSizeAnalysis.issues.length > 0) {
        auditResult.recommendations.push({ priority: 'high', area: 'target-size', message: targetSizeAnalysis.issues.length + ' variant(s) below ' + minTarget + 'x' + minTarget + 'px minimum target size (WCAG 2.5.8)' });
      }
      if (!annotations.hasDescription) {
        auditResult.recommendations.push({ priority: 'medium', area: 'documentation', message: 'Add a component description with usage guidelines' });
      }
      if (!annotations.hasA11yNotes) {
        var a11yHint = isInteractive
          ? 'Add accessibility notes (ARIA role, keyboard interactions, screen reader behavior)'
          : 'Add accessibility notes (ARIA role, live region behavior, semantic usage)';
        auditResult.recommendations.push({ priority: 'medium', area: 'documentation', message: a11yHint });
      }
      if (colorBlindAnalysis.issues.length > 0) {
        auditResult.recommendations.push({ priority: 'medium', area: 'color-blind', message: colorBlindAnalysis.issues.join('; ') });
      }
      if (isInteractive) {
        for (var msi = 0; msi < missingStates.length; msi++) {
          var ms = missingStates[msi];
          if (ms === 'focus' || ms === 'disabled') {
            auditResult.recommendations.push({ priority: 'medium', area: 'states', message: 'Consider adding a "' + ms + '" variant for complete interactive state coverage' });
          }
        }
      } else if (variantAxisCoverage && variantCount < variantAxisCoverage.expectedCombinations) {
        auditResult.recommendations.push({ priority: 'low', area: 'coverage', message: variantCount + ' of ' + variantAxisCoverage.expectedCombinations + ' axis combinations present — consider adding missing variants for completeness' });
      }

      return auditResult;
}

