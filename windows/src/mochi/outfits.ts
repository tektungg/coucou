// Mochi's outfits, drawn in code. Ported from upstream (Louis-CFM/coucou
// 23c09b9, c97dec1): a port of design/outfits/mochi-outfits.js (the Canvas
// reference the Mac version was built from) and of the Mac's
// NotchBuddy/Sources/CoucouKit/MochiOutfitDrawing.swift, whose fixes win where
// the two differ (front arcs found by silhouette, simplified drawing below
// R = 16, the enter/leave transitions, bunny ears).
//
// Coordinates are BotEngine's body space: origin at the body centre, y down,
// R = W × 0.3, rx = 1.14 R, ry = 0.88 R. The head is a superellipsoid whose
// horizontal radius at height y (y up, −1…1) is (1 − |y|^2.7)^(1/2.7), so its
// silhouette matches Mochi's body at yaw = pitch = 0. Accessories are seen
// slightly from above and follow the head pitch only partly, so a hat never
// flips to a top-down view.
//
// This file is the public entry; the drawing lives in ./outfits/:
//   head.ts      the head's geometry, its projection and the eye positions
//   paint.ts     gradients, paths, rounded rectangles, a hat's shadow
//   soft.ts      pompoms and fuzzy trim
//   hats.ts      beanie, Santa hat, party hat
//   crown.ts     the crown (back and front halves)
//   witchHat.ts  the witch hat (brim behind, brim and cone in front)
//   glasses.ts   sunglasses and round glasses, on the eyes
//   faceWear.ts  scarf, pumpkin, bow, bunny ears
//   layers.ts    what goes behind or in front of the body, enter/leave, fading
//   icons.ts     the wardrobe buttons' pictures

export { bodyOutline, eyeFrames, makeHead } from "./outfits/head";
export type { EyeFrame, Head } from "./outfits/head";
export { PUMPKIN_BODY } from "./outfits/faceWear";
export { drawOutfitBehind, drawOutfitFront } from "./outfits/layers";
export type { OutfitState } from "./outfits/layers";
export { drawWardrobeIcon } from "./outfits/icons";
