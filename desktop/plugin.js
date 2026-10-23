/**
 * env-setup — Setup Assistant desktop half.
 *
 * Page /setup: shows the agent's credential request as a masked form when
 * one is pending (chat-driven, on demand). Idle otherwise — this plugin is a
 * minimal credential channel, not a provider catalog. Integrations are
 * declared where they belong: in plugins' own manifests (requires_env).
 *
 * Cancel really ends the ask flow: the request is cancelled server-side,
 * the waiting agent tool returns 'cancelled', and the chip settles.
 *
 * Security invariant: values are POSTed to the plugin backend and written to
 * .env there. They never appear in the chat, in tool results, or in any
 * query cache that the agent can read.
 *
 * Plain ESM, loaded uncompiled — jsx() calls only, no JSX syntax.
 */

import { cn, haptic, host, usePluginI18n, useQuery, useQueryClient, queryClient, ROUTES_AREA, SIDEBAR_NAV_AREA } from '@hermes/plugin-sdk'
import { useEffect, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'env-setup'

let _ctx = null

const api = {
  requests: () => _ctx.rest('/requests'),
  resolve: (rid, values, skipped) =>
    _ctx.rest(`/requests/${rid}/resolve`, { method: 'POST', body: { values, skipped } }),
  cancel: (rid) => _ctx.rest(`/requests/${rid}/cancel`, { method: 'POST', body: {} }),
}

// ── shared bits ─────────────────────────────────────────────────────────────

const pill = cn(
  'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[0.6875rem] font-medium',
  'border border-(--ui-stroke-secondary) text-(--ui-text-tertiary)'
)

const inputCls = cn(
  'w-full rounded-md border border-(--ui-stroke-secondary) bg-transparent',
  'px-2.5 py-1.5 text-sm outline-none',
  'focus:border-(--ui-accent) placeholder:text-(--ui-text-quaternary)'
)

const btnCls = cn(
  'inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium',
  'bg-(--ui-accent) text-white transition-opacity hover:opacity-90 disabled:opacity-50'
)

const btnGhostCls = cn(
  'inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm',
  'border border-(--ui-stroke-secondary) text-(--ui-text-secondary)',
  'transition-colors hover:bg-(--chrome-action-hover)'
)

function FieldRow({ field, value, onChange }) {
  const t = usePluginI18n(ID)
  return jsxs('label', {
    className: 'flex flex-col gap-1',
    children: [
      jsxs('div', {
        className: 'flex flex-wrap items-center gap-2',
        children: [
          jsx('span', { className: 'text-sm font-medium', children: field.label }),
          field.required
            ? jsx('span', { className: 'text-[0.6875rem] text-(--ui-text-tertiary)', children: t('required') })
            : null,
          field.secret
            ? jsx('span', { className: pill, children: '🔒 ' + t('masked') })
            : null,
          field.set
            ? jsx('span', { className: pill, children: '✓ ' + t('alreadySet') })
            : null,
        ],
      }),
      jsx('input', {
        className: inputCls,
        type: field.secret ? 'password' : 'text',
        value: value ?? '',
        placeholder: field.example || field.name,
        autoComplete: 'off',
        autoCorrect: 'off',
        spellCheck: false,
        onChange: (e) => onChange(field.name, e.target.value),
      }),
      field.description
        ? jsx('span', { className: 'text-[0.75rem] text-(--ui-text-quaternary)', children: field.description })
        : null,
      field.url
        ? jsx('a', {
            href: field.url,
            className: 'text-[0.75rem] text-(--ui-accent) hover:underline',
            onClick: (e) => {
              e.preventDefault()
              if (_ctx && _ctx.os) _ctx.os.openExternal(field.url)
            },
            children: t('whereToGet'),
          })
        : null,
    ],
  })
}

function ResultPanel({ result, onDone, t }) {
  const lines = []
  if (result.configured && result.configured.length) {
    lines.push(
      jsxs('div', {
        key: 'ok',
        className: 'flex items-start gap-2',
        children: [
          jsx('span', { children: '✅' }),
          jsxs('span', {
            children: [t('saved'), ' ', jsx('code', { children: result.configured.join(', ') })],
          }),
        ],
      })
    )
  }
  if (result.skipped && result.skipped.length) {
    lines.push(
      jsxs('div', {
        key: 'sk',
        className: 'flex items-start gap-2',
        children: [
          jsx('span', { children: '↩️' }),
          jsxs('span', {
            children: [t('skipped'), ' ', jsx('code', { children: result.skipped.join(', ') })],
          }),
        ],
      })
    )
  }
  return jsxs('div', {
    className: 'flex flex-col gap-4',
    children: [
      jsx('div', {
        className: cn('rounded-lg border p-4',
          result.ok ? 'border-(--ui-stroke-secondary)' : 'border-red-400'),
        children: lines,
      }),
      result.errors && result.errors.length
        ? jsx('div', {
            className: 'text-sm text-red-400',
            children: result.errors.join(' · '),
          })
        : null,
      jsx('div', { className: 'text-[0.75rem] text-(--ui-text-quaternary)', children: t('privacyNote') }),
      jsx('button', { className: btnGhostCls, onClick: onDone, type: 'button', children: t('done') }),
    ],
  })
}

// ── the ask form (chat-driven requests only) ────────────────────────────────

function SetupForm({ request, onResolve, onCancel, t }) {
  const fields = request.fields
  const [values, setValues] = useState({})
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [missingRequired, setMissingRequired] = useState([])

  useEffect(() => {
    setResult(null)
    setValues({})
    setMissingRequired([])
  }, [request.id])

  if (result) return jsx(ResultPanel, { result, onDone: () => { setResult(null) }, t })

  const change = (name, v) => setValues((prev) => ({ ...prev, [name]: v }))

  const submit = async () => {
    const missing = fields.filter((f) => f.required && !(values[f.name] || '').trim()).map((f) => f.name)
    if (missing.length) {
      setMissingRequired(missing)
      return
    }
    setMissingRequired([])
    const provided = {}
    const skipped = []
    for (const f of fields) {
      const v = (values[f.name] || '').trim()
      if (v) provided[f.name] = v
      else if (!f.set) skipped.push(f.name) // empty+unset = user chose to skip
    }
    setBusy(true)
    try {
      const res = await onResolve(provided, skipped)
      setResult({ ok: !res.errors, ...res })
    } catch (err) {
      setResult({ ok: false, errors: [String((err && err.message) || err)] })
    } finally {
      setBusy(false)
    }
  }

  return jsxs('div', {
    className: 'flex flex-col gap-4',
    children: [
      jsxs('div', {
        className: 'flex flex-col gap-1 rounded-lg border border-(--ui-accent) p-4',
        children: [
          jsxs('span', { className: 'text-sm font-semibold', children: ['🔐 ', t('agentAsks')] }),
          jsx('h2', { className: 'text-base font-semibold', children: request.title }),
          request.reason
            ? jsx('span', { className: 'text-[0.75rem] text-(--ui-text-tertiary)', children: request.reason })
            : null,
        ],
      }),
      jsx('div', { className: 'text-[0.75rem] text-(--ui-text-quaternary)', children: t('privacyNote') }),
      jsx('div', {
        className: 'flex flex-col gap-4',
        children: fields.map((f) =>
          jsx('div', {
            className: missingRequired.includes(f.name) ? 'rounded-md border border-red-400 p-2' : '',
            children: jsx(FieldRow, { field: f, value: values[f.name], onChange: change }),
          }, f.name)
        ),
      }),
      missingRequired.length
        ? jsx('div', { className: 'text-sm text-red-400', children: t('missingRequired') })
        : null,
      jsxs('div', { className: 'flex items-center gap-2', children: [
        jsx('button', {
          type: 'button',
          className: btnCls,
          disabled: busy,
          onClick: () => { haptic('tap'); submit() },
          children: busy ? t('saving') : t('save'),
        }),
        jsx('button', {
          type: 'button',
          className: btnGhostCls,
          disabled: busy,
          onClick: () => { haptic('tap'); onCancel() },
          children: t('cancel'),
        }),
      ] }),
    ],
  })
}

// ── page ────────────────────────────────────────────────────────────────────

function SetupPage() {
  const t = usePluginI18n(ID)
  const queryClient = useQueryClient()
  const requestsQuery = useQuery({ queryKey: [ID, 'requests'], queryFn: api.requests, refetchInterval: 5000 })

  const [active, setActive] = useState(null) // the request currently served
  const open = ((requestsQuery.data || {}).requests || []).filter((r) => r.status === 'open')
  const pending = open[0] || null

  // A new incoming request becomes the active one.
  useEffect(() => { if (pending) setActive(pending) }, [pending])

  // Chip navigation sets a storage flag: land directly on the pending request.
  // NOTE: ctx.storage.get(key, fallback) is SYNCHRONOUS (see contrib/plugin.ts
  // createPluginStorage) — no .then().
  useEffect(() => {
    if (!_ctx || !pending) return
    if (_ctx.storage.get('open_request', false)) {
      _ctx.storage.set('open_request', false)
      setActive(pending)
    }
  }, [pending])

  const invalidate = () => queryClient.invalidateQueries({ queryKey: [ID] })

  if (active) {
    return jsxs('div', {
      className: 'mx-auto flex max-w-xl flex-col gap-4 p-6',
      children: [
        jsx(SetupForm, {
          request: active,
          t,
          onResolve: async (values, skipped) => {
            const res = await api.resolve(active.id, values, skipped)
            invalidate()
            return res
          },
          onCancel: async () => {
            await api.cancel(active.id)
            invalidate()
            setActive(null)
          },
        }),
      ],
    })
  }

  return jsxs('div', {
    className: 'mx-auto flex max-w-xl flex-col gap-4 p-6',
    children: [
      jsxs('div', { className: 'flex flex-col gap-2', children: [
        jsx('h1', { className: 'text-lg font-semibold', children: t('pageTitle') }),
        jsx('span', { className: 'text-sm text-(--ui-text-tertiary)', children: t('pageSubtitle') }),
      ]}),
      jsxs('div', {
        className: 'flex flex-col gap-1 rounded-lg border border-(--ui-stroke-secondary) p-4',
        children: [
          jsxs('span', { className: 'text-sm font-medium', children: ['🔐 ', t('idleTitle')] }),
          jsx('span', { className: 'text-[0.75rem] text-(--ui-text-quaternary)', children: t('idleHint') }),
        ],
      }),
      jsx('div', { className: 'text-[0.6875rem] text-(--ui-text-quaternary)', children: t('footer') }),
    ],
  })
}

// ── statusbar chip ──────────────────────────────────────────────────────────

function SetupChip() {
  const t = usePluginI18n(ID)
  const requestsQuery = useQuery({ queryKey: [ID, 'requests'], queryFn: api.requests, refetchInterval: 5000 })
  const open = (((requestsQuery.data || {}).requests || []).filter((r) => r.status === 'open') || []).length
  const cls = open
    ? 'text-(--ui-accent) bg-(--chrome-action-hover)'
    : 'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
  return jsx('button', {
    type: 'button',
    title: open ? t('chipActiveTip') : t('chipTip'),
    className: cn(
      'inline-flex h-full items-center gap-1 px-1.5 text-[0.6875rem] font-medium transition-colors',
      cls,
      open && 'animate-pulse'
    ),
    onClick: () => {
      haptic('tap')
      if (open && _ctx) _ctx.storage.set('open_request', true)
      host.navigate('/setup')
    },
    children: open ? `🔐 ${open}` : '🔐',
  })
}

// ── registration ───────────────────────────────────────────────────────────

export default {
  id: ID,
  name: 'Setup Assistant',
  register(ctx) {
    _ctx = ctx

    ctx.i18n.register({
      de: {
        pageTitle: 'Zugänge',
        pageSubtitle: 'Hermes fragt Zugänge direkt im Chat an, sobald sie gebraucht werden — sie erscheinen dann hier als maskiertes Formular.',
        idleTitle: 'Keine offene Anfrage',
        idleHint: 'Wenn im Chat Zugänge benötigt werden (Mail, Tokens, Passwörter), öffnet sich hier automatisch das Formular. Zugangsdaten landen direkt in der .env — nie im Chat.',
        agentAsks: 'Hermes bittet um Zugänge',
        save: 'In .env speichern',
        saving: 'Speichert…',
        saved: 'Gespeichert:',
        skipped: 'Leer gelassen:',
        cancel: 'Abbrechen',
        done: 'Fertig',
        required: 'Pflichtfeld',
        masked: 'maskiert',
        alreadySet: 'bereits gesetzt',
        whereToGet: 'Wo bekomm ich das? →',
        missingRequired: 'Bitte die markierten Pflichtfelder ausfüllen.',
        privacyNote: 'Deine Werte werden direkt in die .env geschrieben — sie erscheinen nie im Chat und nie im Modellkontext.',
        chipTip: 'Zugänge',
        chipActiveTip: 'Hermes wartet auf Zugänge — klicken zum Ausfüllen',
        footer: 'Integrationen deklarieren ihre Zugänge im plugin.yaml (requires_env) — das Plugin übernimmt sie automatisch.',
      },
      en: {
        pageTitle: 'Credentials',
        pageSubtitle: 'Hermes asks for credentials in the chat the moment they are needed — they show up here as a masked form.',
        idleTitle: 'No open request',
        idleHint: 'When the chat needs credentials (mail, tokens, passwords), the form opens here automatically. Values go straight to .env — never into the chat.',
        agentAsks: 'Hermes is asking for credentials',
        save: 'Save to .env',
        saving: 'Saving…',
        saved: 'Saved:',
        skipped: 'Left empty:',
        cancel: 'Cancel',
        done: 'Done',
        required: 'required',
        masked: 'masked',
        alreadySet: 'already set',
        whereToGet: 'Where do I get this? →',
        missingRequired: 'Please fill the marked required fields.',
        privacyNote: 'Your values are written straight into .env — they never appear in the chat or the model context.',
        chipTip: 'Credentials',
        chipActiveTip: 'Hermes is waiting for credentials — click to fill the form',
        footer: 'Integrations declare their credentials in plugin.yaml (requires_env) — the plugin picks them up automatically.',
      },
    })

    ctx.register({
      id: 'nav',
      area: SIDEBAR_NAV_AREA,
      data: { path: '/setup', label: 'Setups', codicon: 'key' },
    })

    ctx.register({
      id: 'page',
      area: ROUTES_AREA,
      data: { path: '/setup' },
      render: () => jsx(SetupPage, {}),
    })

    ctx.register({
      id: 'chip',
      area: 'statusBar.right',
      order: 140,
      render: () => jsx(SetupChip, {}),
    })

    host.onEvent('plugin.env-setup.request.created', ({ payload }) => {
      const r = payload && payload.request
      host.notify({
        kind: 'info',
        message: r && r.title ? `🔐 ${r.title}` : '🔐 Zugänge werden angefragt',
      })
      try {
        ctx.os.notify({
          title: 'Hermes braucht Zugänge',
          body: (r && r.reason) || 'Ein Formular wartet auf der Setups-Seite.',
          activate: '/setup',
        })
      } catch (e) { /* notifications may be disabled — not fatal */ }
    })

    for (const evt of ['request.resolved', 'request.cancelled']) {
      host.onEvent(`plugin.env-setup.${evt}`, () => {
        try {
          queryClient.invalidateQueries({ queryKey: [ID] })
        } catch (e) { /* refetch interval covers it */ }
      })
    }
  },
}