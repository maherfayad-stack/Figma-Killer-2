/**
 * @core/i18n — dictionary rules shared by the editor and the server.
 *
 * Deliberately tiny and dependency-free: the Content panel and the AI
 * translate handler both need the same answer to "does this entry still need
 * translating", and neither may import the other.
 */
export { isUntranslated } from './translationState'
