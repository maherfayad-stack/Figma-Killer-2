/**
 * base.text — unified semantic text module.
 *
 * Content and semantic tag are module settings; visual typography belongs to
 * class styles. Emits a bare semantic element with no default class or CSS.
 */
import { registry } from '@core/module-engine'
import type { ModuleDefinition } from '@core/module-engine'
import { TextStartTIcon } from 'pixel-art-icons/icons/text-start-t'
import { Value } from '@core/utils/typeboxHelpers'
import {
  htmlAttributesAttr,
  htmlAttributesControl,
} from '@modules/base/shared/htmlAttributes'
import { textToBreakHtml } from '@modules/base/shared/inlineText'
import { textTagControl } from '@modules/base/utils/htmlTag'
import { TextEditor } from './TextEditor'
import { normalizeTag } from './tags'
import { TextPropsSchema, type TextStoredProps } from './props'

export const TextModule: ModuleDefinition<TextStoredProps> = {
  id: 'base.text',
  name: 'Text',
  description: 'A semantic text element.',
  category: 'Typography',
  version: '2.0.0',
  icon: TextStartTIcon,
  trusted: true,
  canHaveChildren: false,
  inlineTextEdit: { prop: 'text', multiline: true },

  schema: {
    text: { type: 'textarea', label: 'Text', rows: 4, placeholder: 'Enter text...' },
    tag: textTagControl(),
    htmlAttributes: htmlAttributesControl(),
  },

  propsSchema: TextPropsSchema,

  defaults: Value.Create(TextPropsSchema),

  component: TextEditor,

  htmlTag: (props) => {
    const tag = normalizeTag(props.tag)
    return tag === 'none' ? null : tag
  },

  render: (props) => {
    // props.text is pre-escaped by escapeProps — only turn newlines into the
    // hard <br> breaks the author typed (sanitizer allows <br>).
    const text = textToBreakHtml(String(props.text))
    const tag = normalizeTag(props.tag)
    if (tag === 'none') {
      return { html: text }
    }
    const attrs = htmlAttributesAttr(props.htmlAttributes)
    return {
      html: `<${tag}${attrs}>${text}</${tag}>`,
    }
  },
}

registry.registerOrReplace(TextModule)
