/**
 * 极简 Markdown 渲染器（自实现，不引依赖）。
 *
 * 支持的语法足够覆盖知识库文章与模型回复：
 * 标题、粗斜体、行内代码、代码块、列表（有序/无序/嵌套）、引用、
 * 分隔线、链接、表格、任务列表、删除线。
 *
 * 安全性：所有文本都作为 React 子节点渲染（自动转义），不注入 HTML。
 */

import { Fragment, type ReactNode } from 'react'

interface MarkdownProps {
  content: string
  className?: string
}

export function Markdown({ content, className = '' }: MarkdownProps): React.JSX.Element {
  return <div className={`markdown selectable ${className}`}>{renderBlocks(content)}</div>
}

/* ----------------------------- 块级解析 ----------------------------- */

function renderBlocks(source: string): ReactNode[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const out: ReactNode[] = []
  let index = 0
  let key = 0

  while (index < lines.length) {
    const line = lines[index]

    // 代码块
    if (/^\s*```/.test(line)) {
      const lang = line.trim().replace(/^```/, '').trim()
      const code: string[] = []
      index++
      while (index < lines.length && !/^\s*```/.test(lines[index])) {
        code.push(lines[index])
        index++
      }
      index++ // 跳过结束的 ```
      out.push(
        <pre key={key++}>
          <code data-lang={lang || undefined}>{code.join('\n')}</code>
        </pre>
      )
      continue
    }

    // 表格：表头 + 分隔行
    if (/\|/.test(line) && index + 1 < lines.length && /^\s*\|?[\s:-]+\|/.test(lines[index + 1])) {
      const header = splitTableRow(line)
      index += 2
      const rows: string[][] = []
      while (index < lines.length && /\|/.test(lines[index]) && lines[index].trim() !== '') {
        rows.push(splitTableRow(lines[index]))
        index++
      }
      out.push(
        <table key={key++}>
          <thead>
            <tr>
              {header.map((cell, i) => (
                <th key={i}>{renderInline(cell)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex}>{renderInline(cell)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )
      continue
    }

    // 标题
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      const level = heading[1].length
      const text = renderInline(heading[2])
      if (level === 1) out.push(<h1 key={key++}>{text}</h1>)
      else if (level === 2) out.push(<h2 key={key++}>{text}</h2>)
      else if (level === 3) out.push(<h3 key={key++}>{text}</h3>)
      else out.push(<h4 key={key++}>{text}</h4>)
      index++
      continue
    }

    // 分隔线
    if (/^\s*([-*_])\s*\1\s*\1[\s\S]*$/.test(line) && line.trim().length >= 3) {
      out.push(<hr key={key++} />)
      index++
      continue
    }

    // 引用（支持多行合并）
    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = []
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>\s?/, ''))
        index++
      }
      out.push(<blockquote key={key++}>{renderBlocks(quote.join('\n'))}</blockquote>)
      continue
    }

    // 列表
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const { node, nextIndex } = renderList(lines, index, 0)
      out.push(<Fragment key={key++}>{node}</Fragment>)
      index = nextIndex
      continue
    }

    // 空行
    if (line.trim() === '') {
      index++
      continue
    }

    // 普通段落：合并连续非空行
    const paragraph: string[] = []
    while (
      index < lines.length &&
      lines[index].trim() !== '' &&
      !/^\s*(#{1,6}\s|>|[-*+]\s|\d+\.\s|```)/.test(lines[index]) &&
      !(/\|/.test(lines[index]) && index + 1 < lines.length && /^\s*\|?[\s:-]+\|/.test(lines[index + 1]))
    ) {
      paragraph.push(lines[index])
      index++
    }
    out.push(<p key={key++}>{renderInline(paragraph.join('\n'))}</p>)
  }

  return out
}

/** 递归渲染列表（支持缩进嵌套） */
function renderList(
  lines: string[],
  start: number,
  indent: number
): { node: ReactNode; nextIndex: number } {
  const items: { content: string; children: ReactNode | null; checked?: boolean }[] = []
  const ordered = /^\s*\d+\.\s+/.test(lines[start] ?? '')
  let index = start

  while (index < lines.length) {
    const line = lines[index]
    const match = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(line)
    if (!match) break
    const currentIndent = match[1].length
    if (currentIndent < indent) break
    if (currentIndent > indent) {
      // 更深缩进属于上一个列表项的子列表
      const nested = renderList(lines, index, currentIndent)
      if (items.length > 0) items[items.length - 1].children = nested.node
      index = nested.nextIndex
      continue
    }
    let text = match[3]
    let checked: boolean | undefined
    const task = /^\[([ xX])\]\s+(.*)$/.exec(text)
    if (task) {
      checked = task[1].toLowerCase() === 'x'
      text = task[2]
    }
    items.push({ content: text, children: null, checked })
    index++
  }

  const body = items.map((item, itemIndex) => (
    <li key={itemIndex} style={item.checked !== undefined ? { listStyle: 'none', marginLeft: -20 } : undefined}>
      {item.checked !== undefined ? (
        <span style={{ marginRight: 6, color: item.checked ? 'var(--c-verdant)' : 'var(--c-text-muted)' }}>
          {item.checked ? '☑' : '☐'}
        </span>
      ) : null}
      {renderInline(item.content)}
      {item.children}
    </li>
  ))

  const node = ordered ? <ol>{body}</ol> : <ul>{body}</ul>
  return { node, nextIndex: index }
}

/* ----------------------------- 行内解析 ----------------------------- */

function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = []
  // 统一的正则：行内代码 | 链接 | 粗体 | 斜体 | 删除线
  const pattern = /(`[^`\n]+`)|(\[[^\]]+\]\([^)\s]+\))|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)|(~~[^~\n]+~~)/g
  let lastIndex = 0
  let match: RegExpExecArray | null
  let key = 0

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(<Fragment key={key++}>{text.slice(lastIndex, match.index)}</Fragment>)
    }
    const token = match[0]
    if (token.startsWith('`')) {
      nodes.push(<code key={key++}>{token.slice(1, -1)}</code>)
    } else if (token.startsWith('[')) {
      const link = /\[([^\]]+)\]\(([^)\s]+)\)/.exec(token)
      if (link) {
        const url = link[2]
        const isExternal = /^https?:\/\//i.test(url)
        nodes.push(
          <a
            key={key++}
            href={url}
            onClick={(event) => {
              event.preventDefault()
              if (isExternal) {
                void window.mcal?.system.openExternal(url)
              }
              // 非 http(s) 链接一律不跟随：Markdown 可能来自 Release notes 等外部内容，
              // 放行会让整个窗口被导航到 file:// 之类的地址
            }}
            title={isExternal ? url : undefined}
          >
            {link[1]}
          </a>
        )
      }
    } else if (token.startsWith('**') || token.startsWith('__')) {
      nodes.push(<strong key={key++}>{renderInline(token.slice(2, -2))}</strong>)
    } else if (token.startsWith('~~')) {
      nodes.push(
        <span key={key++} style={{ textDecoration: 'line-through', opacity: 0.7 }}>
          {token.slice(2, -2)}
        </span>
      )
    } else {
      nodes.push(<em key={key++}>{renderInline(token.slice(1, -1))}</em>)
    }
    lastIndex = match.index + token.length
  }

  if (lastIndex < text.length) {
    nodes.push(<Fragment key={key++}>{text.slice(lastIndex)}</Fragment>)
  }
  return nodes
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return trimmed.split('|').map((cell) => cell.trim())
}
