/**
 * ImageSourcePicker — "where does this image fill come from?", the three
 * honest answers, in one control.
 *
 *   1. **This project** — the images already on disk in the open workspace
 *      (`GET /admin/api/studio/project-assets`). Thumbnails are rendered
 *      through `/admin/api/studio/asset`, the authenticated read endpoint the
 *      canvas already uses for an `<img src>`; the URL WRITTEN is never that
 *      one — see `imageFillValue.ts` for why.
 *   2. **Upload** — lands a new file into the project through the existing
 *      `POST /admin/api/studio/asset-upload` pipeline (magic-number sniffing,
 *      symlink-aware containment, collision-safe naming, SVG sanitisation).
 *      No CMS media library is involved: Studio's state lives on disk, in the
 *      user's repo. The upload targets the project's public root so the URL
 *      it produces survives a production build.
 *   3. **URL** — a pasted address, written verbatim. Used for a CDN image, or
 *      for a path the user knows their build resolves and this panel does not.
 *
 * Rendered in two places: inside the Fill header's "add image fill" popover
 * (where picking INSERTS a layer) and inside a layer's own popover (where
 * picking REPLACES that layer's paint). Both hand it the same `onPick`.
 */
import { useState } from 'react'
import { Button } from '@ui/components/Button'
import { Input } from '@ui/components/Input'
import { SearchBar } from '@ui/components/SearchBar'
import { SegmentedControl } from '@ui/components/SegmentedControl'
import { FileUpload } from '@ui/components/FileUpload'
import { pushToast } from '@ui/components/Toast'
import { getErrorMessage } from '@core/utils/errorMessage'
import { CloudUploadSolidIcon } from 'pixel-art-icons/icons/cloud-upload-solid'
import { uploadStudioAsset } from '@site/studio/uploadStudioAsset'
import {
  fetchProjectImageAssets,
  invalidateProjectImageAssets,
  studioAssetPreviewUrl,
  useProjectImageAssets,
} from '@site/studio/projectAssets'
import { cssUrlForAssetPath, IMAGE_FILL_UPLOAD_DIR, imageFillFileName } from './imageFillValue'
import styles from './ImageSourcePicker.module.css'

type PickerTab = 'project' | 'upload' | 'url'

interface ImageSourcePickerProps {
  /** The `url()` payload currently written, or `''` when there is no image yet. */
  value: string
  /** Commits a new `url()` payload. `''` is never passed — an empty pick is a no-op. */
  onPick: (url: string) => void
}

export function ImageSourcePicker({ value, onPick }: ImageSourcePickerProps) {
  const [tab, setTab] = useState<PickerTab>('project')
  const [query, setQuery] = useState('')
  const [uploading, setUploading] = useState(false)
  // The shared, workspace-cached list. `uploaded` is this picker's own view of
  // an upload that has just landed, so the new file appears in the grid
  // immediately without a second round trip for every other mounted picker.
  const [uploaded, setUploaded] = useState<readonly string[] | null>(null)
  const fetched = useProjectImageAssets()
  const assets = uploaded ?? fetched

  async function handleUpload(file: File | undefined) {
    if (!file) return
    setUploading(true)
    try {
      const { relPath } = await uploadStudioAsset(file, { targetDir: IMAGE_FILL_UPLOAD_DIR })
      invalidateProjectImageAssets()
      setUploaded(await fetchProjectImageAssets())
      onPick(cssUrlForAssetPath(relPath).url)
      setTab('project')
    } catch (err) {
      pushToast({
        kind: 'error',
        title: 'Image upload failed',
        body: getErrorMessage(err, 'Unknown upload error'),
      })
    } finally {
      setUploading(false)
    }
  }

  const needle = query.trim().toLowerCase()
  const matches = (assets ?? []).filter((path) => path.toLowerCase().includes(needle))

  return (
    <div className={styles.picker}>
      <SegmentedControl<PickerTab>
        value={tab}
        options={[
          { value: 'project', label: 'Project' },
          { value: 'upload', label: 'Upload' },
          { value: 'url', label: 'URL' },
        ]}
        onChange={setTab}
        fullWidth
        size="sm"
        aria-label="Image source"
      />

      {tab === 'project' && (
        <>
          <SearchBar
            value={query}
            onValueChange={setQuery}
            placeholder="Filter images"
            aria-label="Filter project images"
          />
          {assets === null ? (
            <p className={styles.note}>Reading the project&rsquo;s images&hellip;</p>
          ) : matches.length === 0 ? (
            <p className={styles.note}>
              {assets.length === 0
                ? 'No image files in this project yet. Upload one, or paste a URL.'
                : 'No image matches that filter.'}
            </p>
          ) : (
            <ul className={styles.grid} aria-label="Project images">
              {matches.map((path) => (
                <AssetTile
                  key={path}
                  path={path}
                  selected={cssUrlForAssetPath(path).url === value}
                  onPick={onPick}
                />
              ))}
            </ul>
          )}
        </>
      )}

      {tab === 'upload' && (
        <div className={styles.uploadPane}>
          <p className={styles.note}>
            The file is written into <code>{IMAGE_FILL_UPLOAD_DIR}/</code> in your project, so the
            URL works in your production build as well as in dev.
          </p>
          <FileUpload
            accept="image/png,image/jpeg,image/gif,image/webp,image/avif,image/svg+xml"
            disabled={uploading}
            onChange={(e) => void handleUpload(e.target.files?.[0])}
            buttonProps={{
              variant: 'secondary',
              size: 'xs',
              fullWidth: true,
              loading: uploading,
              'data-testid': 'image-fill-upload',
            }}
          >
            <CloudUploadSolidIcon size={12} aria-hidden="true" />
            Choose a file
          </FileUpload>
        </div>
      )}

      {tab === 'url' && (
        <div className={styles.uploadPane}>
          <Input
            fieldSize="sm"
            value={value}
            placeholder="https://cdn.example.com/hero.png"
            aria-label="Image URL"
            onChange={(e) => onPick(e.target.value)}
          />
          <p className={styles.note}>
            Written into your source exactly as typed. Studio does not check that it resolves.
          </p>
        </div>
      )}
    </div>
  )
}

/**
 * One image in the grid. The caption carries the build-safety verdict from
 * `cssUrlForAssetPath` — a file outside the public root works on the dev
 * server and usually not in a build, and the picker says which it is rather
 * than letting the user find out after deploying.
 */
function AssetTile({
  path,
  selected,
  onPick,
}: {
  path: string
  selected: boolean
  onPick: (url: string) => void
}) {
  const { url, buildSafe } = cssUrlForAssetPath(path)
  return (
    <li className={styles.tile}>
      <Button
        variant="ghost"
        size="xs"
        align="start"
        fullWidth
        pressed={selected}
        className={styles.tileButton}
        tooltip={
          buildSafe
            ? path
            : `${path} — outside the public folder, so your production build will not serve this URL`
        }
        onClick={() => onPick(url)}
      >
        <img className={styles.thumb} src={studioAssetPreviewUrl(path)} alt="" loading="lazy" />
        <span className={styles.tileName}>{imageFillFileName(path)}</span>
        {!buildSafe && (
          <span className={styles.tileWarning} aria-hidden="true">
            dev only
          </span>
        )}
      </Button>
    </li>
  )
}
