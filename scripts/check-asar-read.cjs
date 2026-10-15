/**
 * 用 Electron 自己的 asar 文件系统实现验证打包产物：
 * MCAL 读取模板与知识库靠的是 readdir + readFile 遍历 asar 内目录，
 * 这是打包后最容易出问题的一环。必须用 Electron（而非 Node）来跑，因为只有
 * Electron 的 fs 被 patch 过。
 *
 *   npx electron scripts/check-asar-read.cjs [app.asar 路径]
 */

const { app } = require('electron')
const { readdir, readFile, stat } = require('node:fs/promises')
const { join } = require('node:path')

const asarPath = process.argv[2] || 'release/win-unpacked/resources/app.asar'

async function walk(root, prefix = '') {
  const out = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...(await walk(join(root, entry.name), rel)))
    else out.push(rel)
  }
  return out
}

app.whenReady().then(async () => {
  let failures = 0
  const check = (label, ok, detail = '') => {
    if (!ok) failures++
    console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
  }

  try {
    console.log(`asar: ${asarPath}\n`)

    // 1. readdir 遍历知识库（KnowledgeBase.buildIndex 的路径）
    const knowledgeRoot = join(asarPath, 'resources/knowledge')
    const categories = (await readdir(knowledgeRoot, { withFileTypes: true })).filter((e) => e.isDirectory())
    check('readdir 知识库分类', categories.length === 11, `${categories.length} 个分类`)

    const articles = await walk(knowledgeRoot)
    check('遍历知识库文章', articles.length === 57, `${articles.length} 篇`)

    // 2. readFile 读取文章内容
    const sample = join(knowledgeRoot, 'crash', 'crash-mixin-failed.md')
    const text = await readFile(sample, 'utf8')
    check('readFile 知识库文章', text.length > 100, `${text.length} 字符`)

    // 3. readdir + readFile 遍历模板（TemplateRegistry.readFilesOf 的路径）
    const templatesRoot = join(asarPath, 'resources/templates')
    const templateDirs = (await readdir(templatesRoot, { withFileTypes: true })).filter((e) => e.isDirectory())
    check('readdir 模板目录', templateDirs.length === 8, `${templateDirs.length} 个模板`)

    const templateFiles = await walk(join(templatesRoot, 'mod-fabric-1.20'))
    check('遍历模板文件', templateFiles.length > 10, `${templateFiles.length} 个文件`)

    const manifestRaw = await readFile(join(templatesRoot, 'mod-fabric-1.20/template.json'), 'utf8')
    const manifest = JSON.parse(manifestRaw)
    check('读取并解析 template.json', manifest.id === 'mod-fabric-1.20')
    check('template.json 的 directories 声明可读', Array.isArray(manifest.directories), JSON.stringify(manifest.directories))

    // 4. 技能手册
    const skillText = await readFile(join(asarPath, 'resources/skills/diagnose-crash/SKILL.md'), 'utf8')
    check('readFile 技能手册', skillText.length > 200, `${skillText.length} 字符`)

    // 5. 主进程产物（确认 asar 内入口可 stat）
    const mainStat = await stat(join(asarPath, 'out/main/index.js'))
    check('stat 主进程产物', mainStat.size > 100_000, `${(mainStat.size / 1024).toFixed(0)} KB`)

    console.log(failures === 0 ? '\n✓ asar 内资源可正常 readdir/readFile' : `\n✗ ${failures} 项失败`)
  } catch (err) {
    failures++
    console.error(`\n✗ 异常：${err && err.stack ? err.stack : String(err)}`)
  } finally {
    app.exit(failures === 0 ? 0 : 1)
  }
})
