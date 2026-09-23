import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import {
  uploadFile,
  deleteFile,
  listFiles,
  listPacks,
  createPack,
  renamePack,
  deletePack,
  setPackStickers,
  buildPack,
  fetchPackManifest,
  listStickers,
  deleteSticker,
  setStickerEmojis,
} from './api.js'
import type { FileRecord, StickerView } from './types.js'
import type { PackSummary } from './api.js'
import { reducer, initialState, activePack, shelfFiles } from './flow.js'
import Editor from './components/Editor.jsx'
import PacksHome from './components/PacksHome.jsx'
import PackCanvas from './components/PackCanvas.jsx'
import InstallDrawer from './components/InstallDrawer.jsx'
import StickerLibrary from './components/StickerLibrary.jsx'
import StickerPicker from './components/StickerPicker.jsx'
import { authRequired, signOutUser } from './auth.js'

export default function App() {
  const [state, dispatch] = useReducer(reducer, undefined, initialState)
  const [allStickers, setAllStickers] = useState<StickerView[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [editorTarget, setEditorTarget] = useState<{ file: FileRecord; replaceAt?: number } | null>(null)
  const replaceIndexRef = useRef<number | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const refreshPacks = async (): Promise<PackSummary[]> => {
    const packs = await listPacks().catch(() => [])
    dispatch({ type: 'setPacks', packs })
    return packs
  }

  const refreshStickers = async (): Promise<StickerView[]> => {
    const stickers = await listStickers().catch(() => [])
    setAllStickers(stickers)
    return stickers
  }

  const hydrateShelf = async (code: string): Promise<void> => {
    const [files, packs] = await Promise.all([listFiles().catch(() => [] as FileRecord[]), refreshPacks()])
    const pack = packs.find(p => p.code === code)
    dispatch({ type: 'setStaged', files: shelfFiles(files, pack?.stickers.map(s => s.fileId) ?? []) })
  }

  const openPack = (code: string): void => {
    dispatch({ type: 'openPack', code })
    void hydrateShelf(code)
  }

  useEffect(() => {
    void refreshPacks()
  }, [])

  useEffect(() => {
    if (state.route === 'stickers' || pickerOpen) {
      refreshStickers()
    }
  }, [state.route, pickerOpen])

  const packsByJob = useMemo(() => {
    const map: Record<string, string[]> = {}
    for (const p of state.packs) {
      for (const id of p.jobIds) {
        (map[id] ??= []).push(p.name)
      }
    }
    return map
  }, [state.packs])

  const memChain = useRef<Promise<unknown>>(Promise.resolve())
  const mutateMembership = (code: string, change: (current: string[]) => string[]): Promise<void> => {
    const next = memChain.current.then(async () => {
      const packs = await listPacks()
      const pack = packs.find(p => p.code === code)
      const updated = await setPackStickers(code, change(pack?.jobIds ?? []))
      dispatch({ type: 'setPacks', packs: packs.map(p => p.code === code ? updated : p) })
    })
    memChain.current = next.catch(() => {})
    return next
  }

  const addFiles = async (list: File[]): Promise<void> => {
    for (const f of list) {
      const ok = /\.(mp4|mov|webm|mkv|avi|m4v|png|jpe?g|webp|bmp|gif)$/i.test(f.name) || f.type.startsWith('video/') || f.type.startsWith('image/')
      if (!ok) continue
      const key = `${f.name}-${f.size}-${Math.random().toString(36).slice(2)}`
      dispatch({ type: 'uploadStart', upload: { key, name: f.name, progress: 0 } })
      try {
        const rec = await uploadFile(f, p => dispatch({ type: 'uploadProgress', key, progress: p }))
        dispatch({ type: 'uploadDone', key })
        dispatch({ type: 'staged', files: [rec] })
        if (replaceIndexRef.current != null) {
          const replaceAt = replaceIndexRef.current
          replaceIndexRef.current = null
          setEditorTarget({ file: rec, replaceAt })
        }
      } catch (err) {
        dispatch({ type: 'uploadDone', key })
        alert(`Failed: ${f.name}\n${err instanceof Error ? err.message : 'unknown error'}`)
      }
    }
  }

  const onCommitted = async (jobId: string, _size?: number, replaceAt?: number): Promise<void> => {
    const code = state.activeCode
    if (!code) return
    await mutateMembership(code, ids => {
      const next = ids.filter(id => id !== jobId)
      if (replaceAt != null && replaceAt >= 0 && replaceAt <= next.length) {
        next.splice(replaceAt, 1, jobId)
      } else {
        next.push(jobId)
      }
      return next
    })
    if (editorTarget) dispatch({ type: 'committed', fileId: editorTarget.file.id })
    setEditorTarget(null)
    await Promise.all([refreshPacks(), refreshStickers()])
  }

  const onFineTune = async (s: StickerView): Promise<void> => {
    if (!s.editable) return
    const stagedFile = state.staged.find(f => f.id === s.fileId)
    if (stagedFile) {
      const pack = activePack(state)
      const replaceAt = pack?.stickers.findIndex(x => x.jobId === s.jobId)
      setEditorTarget({ file: stagedFile, replaceAt: replaceAt !== -1 ? replaceAt : undefined })
      return
    }
    const files = await listFiles()
    const f = files.find(x => x.id === s.fileId)
    if (!f) {
      alert('Source file is no longer available')
      return
    }
    const pack = activePack(state)
    const replaceAt = pack?.stickers.findIndex(x => x.jobId === s.jobId)
    setEditorTarget({ file: f, replaceAt: replaceAt !== -1 ? replaceAt : undefined })
  }

  const onReplace = (s: StickerView): void => {
    const pack = activePack(state)
    if (!pack) return
    replaceIndexRef.current = pack.stickers.findIndex(x => x.jobId === s.jobId)
    inputRef.current?.click()
  }

  const onRemove = async (s: StickerView): Promise<void> => {
    const code = state.activeCode
    if (!code) return
    await mutateMembership(code, ids => ids.filter(id => id !== s.jobId))
    await refreshPacks()
  }

  const onReorder = async (nextJobIds: string[]): Promise<void> => {
    const code = state.activeCode
    if (!code) return
    await mutateMembership(code, () => nextJobIds)
  }

  const onPickExisting = async (jobId: string): Promise<void> => {
    const code = state.activeCode
    if (!code) return
    setPickerOpen(false)
    await mutateMembership(code, ids => [...ids, jobId])
    await refreshPacks()
  }

  const onDeleteSticker = async (s: StickerView): Promise<void> => {
    const packs = packsByJob[s.jobId] ?? []
    const where = packs.length ? `\n\nIt is used in: ${packs.join(', ')}.` : ''
    if (!confirm(`Delete “${s.name}” everywhere?${where}\n\nThis cannot be undone.`)) return
    await deleteSticker(s.jobId)
    await Promise.all([refreshPacks(), refreshStickers()])
  }

  const onSetEmojis = async (jobId: string, emojis: string[]): Promise<void> => {
    await setStickerEmojis(jobId, emojis)
    await Promise.all([refreshPacks(), refreshStickers()])
  }

  const newPack = async (): Promise<void> => {
    const name = prompt('Name this pack', `Pack ${state.packs.length + 1}`)?.trim()
    if (!name) return
    const p = await createPack(name)
    await refreshPacks()
    openPack(p.code)
  }

  const renamePackByCode = async (code: string): Promise<void> => {
    const p = state.packs.find(x => x.code === code)
    if (!p) return
    const name = prompt('Rename pack', p.name)?.trim()
    if (!name || name === p.name) return
    await renamePack(code, name)
    await refreshPacks()
  }

  const deletePackByCode = async (code: string): Promise<void> => {
    const p = state.packs.find(x => x.code === code)
    if (!p) return
    if (!confirm(`Delete pack "${p.name}"? Stickers used only by this pack are removed too.`)) return
    await deletePack(code)
    await refreshPacks()
  }

  const doBuild = async (): Promise<void> => {
    const pack = activePack(state)
    if (!pack) return
    const editable = pack.stickers.filter(s => s.editable).length
    if (
      editable > 0 &&
      !confirm(
        `Build "${pack.name}"?\n\nThis deletes the original videos for ${editable} sticker` +
          `${editable === 1 ? '' : 's'}. The stickers keep working and the pack can still be ` +
          `rebuilt — but they can no longer be re-cropped or re-trimmed.`
      )
    )
      return
    dispatch({ type: 'buildStart' })
    try {
      const manifest = await buildPack(pack.code, e => dispatch({ type: 'buildProgress', ...e }))
      dispatch({ type: 'buildOk', manifest })
      await refreshPacks()
    } catch (err) {
      dispatch({ type: 'buildFail', error: err instanceof Error ? err.message : 'Pack build failed' })
    }
  }

  const onEditStaged = (fileId: string): void => {
    const f = state.staged.find(x => x.id === fileId)
    if (f) setEditorTarget({ file: f })
  }

  const onDiscardStaged = async (fileId: string): Promise<void> => {
    const name = state.staged.find(x => x.id === fileId)?.originalName ?? 'this upload'
    if (!confirm(`Discard “${name}”?\n\nThe upload is deleted from the server. This cannot be undone.`)) return
    await deleteFile(fileId).catch(() => {})
    dispatch({ type: 'discard', fileId })
  }

  const onShowInstall = async (): Promise<void> => {
    const code = state.activeCode
    if (!code) return
    if (state.built?.code === code) {
      dispatch({ type: 'openInstall' })
      return
    }
    try {
      const manifest = await fetchPackManifest(code)
      dispatch({ type: 'showInstall', manifest })
    } catch (err) {
      alert(err instanceof Error ? err.message : 'No built pack found')
    }
  }

  const active = activePack(state)

  return (
    <div
      className="app"
      onDragOver={e => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={e => { if (e.currentTarget === e.target) setDragOver(false) }}
      onDrop={e => { e.preventDefault(); setDragOver(false); addFiles([...e.dataTransfer.files]) }}
    >
      <header className="header">
        <div className="brand" onClick={() => dispatch({ type: 'closePack' })} style={{ cursor: 'pointer' }}>
          <span className="logo">⚡</span>
          <div><h1>Sticker<em>Forge</em></h1><p>video → die-cut stickers</p></div>
        </div>
        {authRequired && (
          <button className="btn btn-ghost btn-sm" type="button" onClick={() => void signOutUser()}>Sign out</button>
        )}
      </header>

      {state.route === 'packs' && (
        <PacksHome
          packs={state.packs}
          onOpen={openPack}
          onNew={newPack}
          onRename={renamePackByCode}
          onDelete={deletePackByCode}
          onOpenStickers={() => dispatch({ type: 'openStickers' })}
        />
      )}

      {state.route === 'stickers' && (
        <StickerLibrary
          stickers={allStickers}
          packsByJob={packsByJob}
          onBack={() => dispatch({ type: 'closePack' })}
          onDelete={onDeleteSticker}
          onSetEmojis={onSetEmojis}
        />
      )}

      {state.route === 'pack' && active && (
        <PackCanvas
          pack={active}
          staged={state.staged}
          uploading={state.uploading}
          encoding={state.encoding}
          errors={state.errors}
          building={state.building}
          buildProgress={state.buildProgress}
          buildError={state.buildError}
          onBack={() => dispatch({ type: 'closePack' })}
          onRename={() => renamePackByCode(active.code)}
          onAddMedia={() => inputRef.current?.click()}
          onAddExisting={() => setPickerOpen(true)}
          onEditStaged={onEditStaged}
          onDiscardStaged={onDiscardStaged}
          onReorder={onReorder}
          onFineTune={onFineTune}
          onReplace={onReplace}
          onRemove={onRemove}
          onBuild={doBuild}
          onShowInstall={() => void onShowInstall()}
          installOpen={state.installOpen}
        />
      )}

      {state.route === 'pack' && !active && (
        <main className="empty">
          <div className="empty-box">
            <h2>Pack not found</h2>
            <button className="btn btn-primary" onClick={() => dispatch({ type: 'closePack' })}>← Back to packs</button>
          </div>
        </main>
      )}

      {state.installOpen && state.built && (
        <InstallDrawer
          manifest={state.built}
          stickers={active?.stickers ?? []}
          building={state.building}
          buildProgress={state.buildProgress}
          onClose={() => dispatch({ type: 'closeInstall' })}
          onRebuild={doBuild}
        />
      )}

      {pickerOpen && active && (
        <StickerPicker
          stickers={allStickers}
          exclude={active.jobIds}
          onPick={onPickExisting}
          onClose={() => setPickerOpen(false)}
        />
      )}

      {dragOver && <div className="drop-overlay"><div>⬇ Drop media to import</div></div>}
      <input
        ref={inputRef}
        type="file"
        accept="video/*,image/*,.mkv"
        multiple
        hidden
        onChange={e => {
          if (e.target.files) addFiles([...e.target.files])
          e.target.value = ''
        }}
      />
      {editorTarget && (
        <Editor
          file={editorTarget.file}
          replaceAt={editorTarget.replaceAt}
          onClose={() => setEditorTarget(null)}
          onAddedToPack={onCommitted}
        />
      )}
    </div>
  )
}
