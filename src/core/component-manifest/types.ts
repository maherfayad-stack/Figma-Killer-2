export interface PropSpec {
  name: string
  tsType: string
  required: boolean
  defaultValue?: string
  enumValues?: string[]
  description?: string
}

export interface ComponentSpec {
  name: string
  file: string
  exportName: string
  isDefaultExport: boolean
  props: PropSpec[]
}

export interface ComponentManifest {
  components: ComponentSpec[]
}
