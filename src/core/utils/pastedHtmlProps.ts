/**
 * Which prop names a pasted tree may carry (G-10) - ONE list, because two sides
 * must agree on it: the editor's converter drops (and counts) a name outside it,
 * and the server's guard refuses a paste that still holds one.
 */

/**
 * The prop names a pasted tree may carry, ALLOWLISTED and compared lowercased
 * (`HREF`, `Src` and `ACTION` are the same attribute to a browser and must be
 * the same to this check). A name outside it, `data-*` and `aria-*` aside, refuses
 * the paste: a prop this list does not know has not been judged for where it
 * can send the page. Event handlers are not in it, nor is anything React
 * treats as its own (`key`, `ref`, `children`, `dangerouslySetInnerHTML`) or
 * that runs a document (`srcDoc`).
 */
const ALLOWED_PROPS: ReadonlySet<string> = new Set(
  (
    // global + text
    'id classname title lang dir role tabindex hidden style accesskey draggable contenteditable spellcheck translate slot ' +
    'itemprop itemscope itemtype itemid itemref autocapitalize inputmode enterkeyhint popover nonce part ' +
    // links, media, images
    'href target rel download hreflang type media src srcset sizes alt width height loading decoding crossorigin ' +
    'referrerpolicy fetchpriority usemap ismap controls autoplay loop muted preload poster playsinline kind srclang ' +
    'label default cite datetime start reversed open ' +
    // forms and tables
    'name value defaultvalue defaultchecked checked disabled readonly required multiple selected placeholder maxlength ' +
    'minlength min max step pattern size autocomplete autofocus form formaction formenctype formmethod formnovalidate ' +
    'formtarget action method enctype novalidate accept acceptcharset htmlfor for list cols rows wrap colspan rowspan ' +
    'headers scope span dirname popovertarget popovertargetaction ' +
    // legacy presentation still common in pasted pages
    'align valign bgcolor border cellpadding cellspacing color face nowrap background ' +
    // svg
    'viewbox xmlns xmlnsxlink xlinkhref xlinktitle xmlspace xmllang preserveaspectratio d points pathlength x y x1 x2 y1 y2 ' +
    'cx cy r rx ry dx dy rotate textlength lengthadjust transform fill fillopacity fillrule stroke strokewidth strokeopacity ' +
    'strokelinecap strokelinejoin strokemiterlimit strokedasharray strokedashoffset opacity clippath cliprule clip mask ' +
    'maskunits maskcontentunits clippathunits filter filterunits primitiveunits flood floodcolor floodopacity stopcolor ' +
    'stopopacity offset gradientunits gradienttransform spreadmethod fx fy fr patternunits patterncontentunits ' +
    'patterntransform markerstart markermid markerend markerwidth markerheight markerunits refx refy orient overflow ' +
    'visibility display fontfamily fontsize fontstyle fontweight fontvariant fontstretch letterspacing wordspacing ' +
    'textanchor textdecoration dominantbaseline alignmentbaseline baselineshift writingmode direction unicodebidi ' +
    'colorinterpolation colorinterpolationfilters colorrendering shaperendering textrendering imagerendering ' +
    'pointerevents vectoreffect paintorder mixblendmode isolation cursor lightingcolor in in2 result stddeviation ' +
    'edgemode kernelmatrix divisor bias order targetx targety operator k1 k2 k3 k4 mode values tablevalues slope intercept ' +
    'amplitude exponent basefrequency numoctaves seed stitchtiles xchannelselector ychannelselector scale surfaceconstant ' +
    'diffuseconstant specularconstant specularexponent azimuth elevation limitingconeangle pointsatx pointsaty pointsatz ' +
    'kernelunitlength preservealpha systemlanguage requiredextensions requiredfeatures ' +
    // svg animation (their URL-carrying members are judged in guardAnimation)
    'attributename attributetype from to by begin end dur min max restart repeatcount repeatdur calcmode keytimes keysplines ' +
    'keypoints additive accumulate path type href allowfullscreen inert disablepictureinpicture disableremoteplayback controlslist'
  ).split(' '),
)

/** Whether a prop (any case: `HREF` is `href`) is on the allowlist, or a `data-*` / `aria-*` attribute. */
export function isAllowedPastedProp(name: string): boolean {
  const lower = name.toLowerCase().replace(/[-:]/g, '')
  return ALLOWED_PROPS.has(lower) || /^(?:data|aria)-[a-z0-9_.-]+$/i.test(name)
}
