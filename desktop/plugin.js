/**
 * env-setup — Setup Assistant desktop half.
 *
 * Page /setup (sidebar row "Setups"): catalog of integrations with live
 * set/unset status, masked forms. When the agent requests credentials
 * (env_setup_prompt), a pending-request form opens here and the statusbar
 * key chip lights up.
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
  catalog: () => _ctx.rest('/catalog'),
  requests: () => _ctx.rest('/requests'),
  resolve: (rid, values, skipped) =>
    _ctx.rest(`/requests/${rid}/resolve`, { method: 'POST', body: { values, skipped } }),
  cancel: (rid) => _ctx.rest(`/requests/${rid}/cancel`, { method: 'POST', body: {} }),
  configure: (integrationId, values, skipped) =>
    _ctx.rest('/configure', { method: 'POST', body: { integration_id: integrationId, values, skipped } }),
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

function ResultPanel({ result, onBack, t }) {
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
      jsx('button', { className: btnGhostCls, onClick: onBack, type: 'button', children: t('back') }),
    ],
  })
}

// ── form (shared by agent-request and direct-integration flows) ─────────────

function SetupForm({ fields, title, subtitle, submitLabel, onSubmit, onBack, t }) {
  const [values, setValues] = useState({})
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [missingRequired, setMissingRequired] = useState([])

  useEffect(() => {
    setResult(null)
    setValues({})
    setMissingRequired([])
  }, [fields])

  if (result) return jsx(ResultPanel, { result, onBack, t })

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
      const res = await onSubmit(provided, skipped)
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
        className: 'flex flex-col gap-1',
        children: [
          jsx('button', {
            type: 'button',
            className: cn('self-start text-[0.75rem] text-(--ui-text-tertiary) hover:text-(--ui-text-secondary)'),
            onClick: onBack,
            children: '← ' + t('back'),
          }),
          jsx('h2', { className: 'text-base font-semibold', children: title }),
          subtitle ? jsx('span', { className: 'text-sm text-(--ui-text-tertiary)', children: subtitle }) : null,
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
          children: busy ? t('saving') : submitLabel,
        }),
        jsx('button', { type: 'button', className: btnGhostCls, onClick: onBack, children: t('cancel') }),
      ] }),
    ],
  })
}

// ── catalog card ────────────────────────────────────────────────────────────

function IntegrationCard({ integration, onOpen }) {
  const required = integration.fields.filter((f) => f.required)
  const setRequired = required.filter((f) => f.set).length
  const complete = required.length > 0 && setRequired === required.length
  return jsxs('button', {
    type: 'button',
    onClick: () => { haptic('tap'); onOpen(integration) },
    className: cn(
      'flex flex-col gap-2 rounded-lg border border-(--ui-stroke-secondary) p-4 text-left',
      'transition-colors hover:bg-(--chrome-action-hover)'
    ),
    children: [
      jsxs('div', {
        className: 'flex items-center justify-between gap-2',
        children: [
          jsxs('span', { className: 'flex items-center gap-2 text-sm font-semibold', children: [
            jsx('span', {
              className: 'inline-flex h-2 w-2 rounded-full',
              style: { backgroundColor: complete ? 'var(--ui-accent)' : 'var(--ui-text-quaternary)' },
            }),
            integration.label,
          ]}),
          complete ? jsx('span', { className: pill, children: '✓ bereit' }) : null,
        ],
      }),
      jsx('span', { className: 'text-[0.75rem] text-(--ui-text-quaternary)', children: integration.description }),
      jsx('span', {
        className: 'text-[0.6875rem] text-(--ui-text-tertiary)',
        children: `${setRequired}/${required.length || integration.fields.length}`,
      }),
    ],
  })
}

// ── page ────────────────────────────────────────────────────────────────────

function SetupPage() {
  const t = usePluginI18n(ID)
  const queryClient = useQueryClient()
  const requestsQuery = useQuery({ queryKey: [ID, 'requests'], queryFn: api.requests, refetchInterval: 5000 })
  const catalogQuery = useQuery({ queryKey: [ID, 'catalog'], queryFn: api.catalog, refetchInterval: 30000 })

  const [view, setView] = useState('catalog') // catalog | request | form
  const [selected, setSelected] = useState(null)

  const open = ((requestsQuery.data || {}).requests || []).filter((r) => r.status === 'open')
  const pending = open[0] || null
  const integrations = (catalogQuery.data || {}).integrations || []

  // Chip navigation sets a storage flag: land directly on the pending request.
  useEffect(() => {
    let alive = true
    if (!_ctx) return () => {}
    _ctx.storage.get('open_request').then((flag) => {
      if (alive && flag && pending) {
        setView('request')
        _ctx.storage.set('open_request', false)
      }
    })
    return () => { alive = false }
  }, [pending])

  const invalidate = () => queryClient.invalidateQueries({ queryKey: [ID] })

  if (view === 'request' && pending) {
    return jsxs('div', {
      className: 'mx-auto flex max-w-xl flex-col gap-4 p-6',
      children: [
        jsxs('div', {
          className: 'flex flex-col gap-1 rounded-lg border border-(--ui-accent) p-4',
          children: [
            jsxs('span', { className: 'text-sm font-semibold', children: ['🔐 ', t('agentAsks')] }),
            jsx('span', { className: 'text-[0.75rem] text-(--ui-text-tertiary)', children: pending.reason || '' }),
          ],
        }),
        jsx(SetupForm, {
          fields: pending.fields,
          title: pending.title,
          subtitle: t('agentSubtitle'),
          submitLabel: t('save'),
          onBack: () => setView('catalog'),
          onSubmit: async (values, skipped) => {
            const res = await api.resolve(pending.id, values, skipped)
            invalidate()
            return res
          },
          t,
        }),
      ],
    })
  }

  if (view === 'form' && selected) {
    return jsxs('div', {
      className: 'mx-auto flex max-w-xl flex-col gap-4 p-6',
      children: [
        pending
          ? jsxs('button', {
              type: 'button',
              className: cn('self-start rounded-md border border-(--ui-accent) px-3 py-1.5 text-sm'),
              onClick: () => setView('request'),
              children: ['🔐 ', t('agentAsks'), ' →'],
            })
          : null,
        jsx(SetupForm, {
          fields: selected.fields,
          title: selected.label,
          subtitle: selected.description,
          submitLabel: t('save'),
          onBack: () => setView('catalog'),
          onSubmit: async (values, skipped) => {
            const res = await api.configure(selected.id, values, skipped)
            invalidate()
            return res
          },
          t,
        }),
      ],
    })
  }

  return jsxs('div', {
    className: 'mx-auto flex max-w-xl flex-col gap-4 p-6',
    children: [
      jsxs('div', { className: 'flex flex-col gap-1', children: [
        jsx('h1', { className: 'text-lg font-semibold', children: t('pageTitle') }),
        jsx('span', { className: 'text-sm text-(--ui-text-tertiary)', children: t('pageSubtitle') }),
      ]}),
      pending
        ? jsxs('button', {
            type: 'button',
            className: cn('flex flex-col items-start gap-1 rounded-lg border border-(--ui-accent) p-4 text-left'),
            onClick: () => { haptic('tap'); setView('request') },
            children: [
              jsxs('span', { className: 'text-sm font-semibold', children: ['🔐 ', t('agentAsks'), ': ', pending.title] }),
              pending.reason
                ? jsx('span', { className: 'text-[0.75rem] text-(--ui-text-tertiary)', children: pending.reason })
                : null,
              jsx('span', { className: 'text-[0.75rem] text-(--ui-accent)', children: t('openForm') + ' →' }),
            ],
          })
        : null,
      catalogQuery.isLoading
        ? jsx('div', { className: 'text-sm text-(--ui-text-quaternary)', children: t('loading') })
        : integrations.length
          ? jsx('div', {
              className: 'grid grid-cols-1 gap-3 sm:grid-cols-2',
              children: integrations.map((i) =>
                jsx(IntegrationCard, {
                  integration: i,
                  onOpen: (it) => { setSelected(it); setView('form') },
                }, i.id)
              ),
            })
          : jsx('div', { className: 'text-sm text-(--ui-text-quaternary)', children: t('empty') }),
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
      if (_ctx) _ctx.storage.set('open_request', true)
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
        pageTitle: 'Zugänge & Integrationen',
        pageSubtitle: 'Verbinde Hermes mit deinen Diensten — Zugangsdaten landen direkt in der .env, niemals im Chat.',
        agentAsks: 'Hermes bittet um Zugänge',
        agentSubtitle: 'Das Formular kam aus dem Chat: Werte werden direkt gespeichert, ohne den Chat zu passieren.',
        openForm: 'Formular öffnen',
        save: 'In .env speichern',
        saving: 'Speichert…',
        saved: 'Gespeichert:',
        skipped: 'Leer gelassen:',
        cancel: 'Abbrechen',
        back: 'Zurück',
        required: 'Pflichtfeld',
        masked: 'maskiert',
        alreadySet: 'bereits gesetzt',
        whereToGet: 'Wo bekomm ich das? →',
        missingRequired: 'Bitte die markierten Pflichtfelder ausfüllen.',
        privacyNote: 'Deine Werte werden verschlüsselt in der .env gespeichert — sie erscheinen nie im Chat und nie im Modellkontext.',
        loading: 'Lade Katalog…',
        empty: 'Keine Integrationen gefunden.',
        chipTip: 'Zugänge & Integrationen',
        chipActiveTip: 'Hermes wartet auf Zugänge — klicken zum Ausfüllen',
        footer: 'Neue Integrationen erscheinen automatisch, wenn Plugins Zugänge deklarieren.',
      },
      en: {
        pageTitle: 'Credentials & Integrations',
        pageSubtitle: 'Connect Hermes to your services — credentials go straight into .env, never into the chat.',
        agentAsks: 'Hermes is asking for credentials',
        agentSubtitle: 'This form came from the chat: values are saved directly without passing through the chat.',
        openForm: 'Open form',
        save: 'Save to .env',
        saving: 'Saving…',
        saved: 'Saved:',
        skipped: 'Left empty:',
        cancel: 'Cancel',
        back: 'Back',
        required: 'required',
        masked: 'masked',
        alreadySet: 'already set',
        whereToGet: 'Where do I get this? →',
        missingRequired: 'Please fill the marked required fields.',
        privacyNote: 'Your values are stored in .env — they never appear in the chat or the model context.',
        loading: 'Loading catalog…',
        empty: 'No integrations found.',
        chipTip: 'Credentials & Integrations',
        chipActiveTip: 'Hermes is waiting for credentials — click to fill the form',
        footer: 'New integrations appear automatically when plugins declare credentials.',
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

    host.onEvent('plugin.env-setup.request.resolved', () => {
      try {
        queryClient.invalidateQueries({ queryKey: [ID] })
      } catch (e) { /* refetch interval covers it */ }
    })
  },
}