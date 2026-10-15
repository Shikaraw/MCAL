/**
 * UI 基础组件：以 CSS 类为视觉载体，组件只负责行为与无障碍。
 * 所有页面都应优先使用这里的组件，保证交互与观感一致。
 */

import { useEffect, useId, useRef, useState, type ChangeEvent, type CSSProperties, type ReactNode } from 'react'
import { IconChevronDown, IconClose, IconSearch } from './icons'

/* ------------------------------- Button ------------------------------- */

export interface ButtonProps {
  children?: ReactNode
  onClick?: () => void
  variant?: 'default' | 'primary' | 'danger' | 'ghost' | 'outline'
  size?: 'sm' | 'md' | 'lg' | 'icon'
  disabled?: boolean
  loading?: boolean
  block?: boolean
  title?: string
  type?: 'button' | 'submit'
  className?: string
  icon?: ReactNode
  style?: CSSProperties
}

export function Button({
  children,
  onClick,
  variant = 'default',
  size = 'md',
  disabled,
  loading,
  block,
  title,
  type = 'button',
  className = '',
  icon,
  style
}: ButtonProps): React.JSX.Element {
  const classes = [
    'mcal-btn',
    variant !== 'default' ? `mcal-btn--${variant}` : '',
    size !== 'md' ? `mcal-btn--${size}` : '',
    block ? 'mcal-btn--block' : '',
    loading ? 'mcal-btn--loading' : '',
    className
  ]
    .filter(Boolean)
    .join(' ')

  const isIconOnly = size === 'icon' || (!children && !!icon)

  return (
    <button
      type={type}
      className={classes}
      onClick={onClick}
      disabled={disabled || loading}
      title={title}
      aria-busy={loading}
      aria-label={isIconOnly ? title : undefined}
      style={style}
    >
      {loading ? <span className="mcal-spinner" /> : icon}
      {children ? <span className="mcal-btn__label">{children}</span> : null}
    </button>
  )
}

/* ------------------------------- Card ------------------------------- */

export function Card({
  children,
  interactive,
  selected,
  flat,
  onClick,
  className = '',
  padding,
  style
}: {
  children: ReactNode
  interactive?: boolean
  selected?: boolean
  flat?: boolean
  onClick?: () => void
  className?: string
  padding?: number | string
  style?: CSSProperties
}): React.JSX.Element {
  const classes = [
    'mcal-card',
    interactive ? 'mcal-card--interactive' : '',
    selected ? 'mcal-card--selected' : '',
    flat ? 'mcal-card--flat' : '',
    className
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      className={classes}
      style={{ ...(padding !== undefined ? { padding } : {}), ...style }}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onClick()
              }
            }
          : undefined
      }
    >
      {children}
    </div>
  )
}

/* ------------------------------- Field ------------------------------- */

export function Field({
  label,
  hint,
  error,
  children,
  required
}: {
  label?: string
  hint?: ReactNode
  error?: string
  children: ReactNode
  required?: boolean
}): React.JSX.Element {
  return (
    <div className="mcal-field">
      {label ? (
        <label className="mcal-field__label">
          {label}
          {required ? <span className="err"> *</span> : null}
        </label>
      ) : null}
      {children}
      {error ? <div className="mcal-field__error">{error}</div> : null}
      {!error && hint ? <div className="mcal-field__hint">{hint}</div> : null}
    </div>
  )
}

/* ------------------------------- Input ------------------------------- */

export interface InputProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  type?: 'text' | 'password' | 'number'
  disabled?: boolean
  invalid?: boolean
  onEnter?: () => void
  autoFocus?: boolean
  className?: string
  monospace?: boolean
  suffix?: ReactNode
}

export function Input({
  value,
  onChange,
  placeholder,
  type = 'text',
  disabled,
  invalid,
  onEnter,
  autoFocus,
  className = '',
  monospace,
  suffix
}: InputProps): React.JSX.Element {
  return (
    <div style={{ position: 'relative', display: 'flex', alignItems: 'center', width: '100%' }}>
      <input
        className={`mcal-input ${invalid ? 'mcal-input--invalid' : ''} ${monospace ? 'mono' : ''} ${className}`}
        value={value}
        type={type}
        disabled={disabled}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
        onKeyDown={
          onEnter
            ? (event) => {
                if (event.key === 'Enter') onEnter()
              }
            : undefined
        }
        style={suffix ? { paddingRight: 36 } : undefined}
        spellCheck={false}
      />
      {suffix ? <div style={{ position: 'absolute', right: 8, display: 'flex' }}>{suffix}</div> : null}
    </div>
  )
}

export function Textarea({
  value,
  onChange,
  placeholder,
  rows = 4,
  disabled,
  monospace,
  className = ''
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  rows?: number
  disabled?: boolean
  monospace?: boolean
  className?: string
}): React.JSX.Element {
  return (
    <textarea
      className={`mcal-textarea ${monospace ? 'mono' : ''} ${className}`}
      value={value}
      rows={rows}
      disabled={disabled}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(event) => onChange(event.target.value)}
    />
  )
}

export function SearchInput({
  value,
  onChange,
  placeholder = '搜索…',
  onEnter
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  onEnter?: () => void
}): React.JSX.Element {
  return (
    <Input
      value={value}
      onChange={onChange}
      onEnter={onEnter}
      placeholder={placeholder}
      suffix={<IconSearch size={15} className="muted" />}
    />
  )
}

/* ------------------------------- Select ------------------------------- */

export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

export function Select({
  value,
  onChange,
  options,
  disabled,
  className = ''
}: {
  value: string
  onChange: (value: string) => void
  options: SelectOption[]
  disabled?: boolean
  className?: string
}): React.JSX.Element {
  return (
    <div style={{ position: 'relative', width: '100%' }}>
      <select
        className={`mcal-select ${className}`}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      <IconChevronDown
        size={15}
        className="muted"
        style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}
      />
    </div>
  )
}

/* ------------------------------- Switch ------------------------------- */

export function Switch({
  checked,
  onChange,
  disabled,
  label
}: {
  checked: boolean
  onChange: (value: boolean) => void
  disabled?: boolean
  label?: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`mcal-switch ${checked ? 'mcal-switch--on' : ''}`}
      onClick={() => onChange(!checked)}
      style={disabled ? { opacity: 0.5 } : undefined}
    />
  )
}

/* ------------------------------- Segmented ------------------------------- */

export function Segmented<T extends string>({
  value,
  onChange,
  options
}: {
  value: T
  onChange: (value: T) => void
  options: { value: T; label: string }[]
}): React.JSX.Element {
  return (
    <div className="mcal-segmented" role="tablist">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={value === option.value}
          className={`mcal-segmented__item ${value === option.value ? 'mcal-segmented__item--active' : ''}`}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

/* ------------------------------- Badge / Chip ------------------------------- */

export function Badge({
  children,
  tone = 'default',
  title
}: {
  children: ReactNode
  tone?: 'default' | 'ok' | 'warn' | 'err' | 'info' | 'violet' | 'gold'
  title?: string
}): React.JSX.Element {
  return <span className={`mcal-badge ${tone !== 'default' ? `mcal-badge--${tone}` : ''}`} title={title}>{children}</span>
}

export function Chip({
  children,
  active,
  onClick,
  title
}: {
  children: ReactNode
  active?: boolean
  onClick?: () => void
  title?: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={title}
      className={`mcal-chip ${active ? 'mcal-chip--active' : ''}`}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

/* ------------------------------- Progress ------------------------------- */

export function Progress({
  value,
  indeterminate,
  tone = 'ok'
}: {
  /** 0-1 */
  value?: number
  indeterminate?: boolean
  tone?: 'ok' | 'info' | 'warn'
}): React.JSX.Element {
  const gradient =
    tone === 'info' ? 'var(--g-aurora)' : tone === 'warn' ? 'var(--g-ember)' : 'var(--g-verdant)'
  return (
    <div className={`mcal-progress ${indeterminate ? 'mcal-progress--indeterminate' : ''}`}>
      <div
        className="mcal-progress__bar"
        style={{
          width: indeterminate ? '35%' : `${Math.max(0, Math.min(1, value ?? 0)) * 100}%`,
          background: gradient
        }}
      />
    </div>
  )
}

/* ------------------------------- Empty ------------------------------- */

export function Empty({
  icon,
  title,
  description,
  action
}: {
  icon?: ReactNode
  title: string
  description?: ReactNode
  action?: ReactNode
}): React.JSX.Element {
  return (
    <div className="mcal-empty">
      {icon ? <div className="mcal-empty__icon">{icon}</div> : null}
      <div className="fs-md bold">{title}</div>
      {description ? <div className="fs-sm muted" style={{ maxWidth: 420 }}>{description}</div> : null}
      {action}
    </div>
  )
}

/* ------------------------------- Tabs ------------------------------- */

export function Tabs<T extends string>({
  value,
  onChange,
  options
}: {
  value: T
  onChange: (value: T) => void
  options: { value: T; label: string; badge?: ReactNode }[]
}): React.JSX.Element {
  return (
    <div className="mcal-tabs" role="tablist">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={value === option.value}
          className={`mcal-tab ${value === option.value ? 'mcal-tab--active' : ''}`}
          onClick={() => onChange(option.value)}
        >
          <span className="row gap-2">
            {option.label}
            {option.badge}
          </span>
        </button>
      ))}
    </div>
  )
}

/* ------------------------------- Tooltip ------------------------------- */

export function Tooltip({
  content,
  children,
  side = 'top'
}: {
  content: ReactNode
  children: ReactNode
  side?: 'top' | 'bottom'
}): React.JSX.Element {
  const [visible, setVisible] = useState(false)
  const id = useId()
  if (!content) return <>{children}</>
  return (
    <span
      className="mcal-tooltip"
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
      onFocus={() => setVisible(true)}
      onBlur={() => setVisible(false)}
      aria-describedby={visible ? id : undefined}
    >
      {children}
      {visible ? (
        <span
          id={id}
          role="tooltip"
          className="mcal-tooltip__content"
          style={
            side === 'top'
              ? { bottom: 'calc(100% + 6px)', left: '50%', transform: 'translateX(-50%)' }
              : { top: 'calc(100% + 6px)', left: '50%', transform: 'translateX(-50%)' }
          }
        >
          {content}
        </span>
      ) : null}
    </span>
  )
}

/* ------------------------------- Divider ------------------------------- */

export function Divider({ vertical }: { vertical?: boolean }): React.JSX.Element {
  return <div className={`mcal-divider ${vertical ? 'mcal-divider--vertical' : ''}`} />
}

/* ------------------------------- Modal ------------------------------- */

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  wide,
  closeOnOverlay = true
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
  closeOnOverlay?: boolean
}): React.JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    // 打开时聚焦弹窗，保证键盘可用
    ref.current?.focus()
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="mcal-overlay"
      onMouseDown={(event) => {
        if (closeOnOverlay && event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className={`mcal-modal ${wide ? 'mcal-modal--wide' : ''}`}
        role="dialog"
        aria-modal="true"
        ref={ref}
        tabIndex={-1}
      >
        <div className="mcal-modal__header">
          <div className="grow fs-lg bold truncate">{title}</div>
          <button className="mcal-btn mcal-btn--ghost mcal-btn--icon" onClick={onClose} aria-label="关闭">
            <IconClose size={16} />
          </button>
        </div>
        <div className="mcal-modal__body">{children}</div>
        {footer ? <div className="mcal-modal__footer">{footer}</div> : null}
      </div>
    </div>
  )
}

/* ------------------------------- Stat ------------------------------- */

export function Stat({
  label,
  value,
  hint,
  tone
}: {
  label: string
  value: ReactNode
  hint?: ReactNode
  tone?: 'ok' | 'warn' | 'err' | 'info'
}): React.JSX.Element {
  return (
    <div className="col gap-1">
      <div className="fs-xs muted">{label}</div>
      <div className={`fs-lg bold ${tone ?? ''}`} style={{ lineHeight: 1.2 }}>
        {value}
      </div>
      {hint ? <div className="fs-xs muted">{hint}</div> : null}
    </div>
  )
}
