import { appList, App, Command, Context } from 'koishi-core'
import { cpus, totalmem, freemem } from 'os'
import {} from 'koishi-database-mysql'

declare module 'koishi-core/dist/app' {
  interface AppOptions {
    label?: string
    statusPort?: number
  }
}

declare module 'koishi-core/dist/database' {
  interface UserData {
    lastCall: Date
  }
}

export interface StatusOptions {
  sort?: (a: AppStatus, b: AppStatus) => number
}

Command.userFields(['lastCall'])

let usage = getCpuUsage()
let appRate: number
let usedRate: number

const sendEventCounter = new WeakMap<App, number[]>()

function memoryRate () {
  const totalMemory = totalmem()
  return {
    app: process.memoryUsage().rss / totalMemory,
    total: 1 - freemem() / totalMemory,
  }
}

function getCpuUsage() {
  let totalIdle = 0, totalTick = 0
  const cpuInfo = cpus()
  const usage = process.cpuUsage().user

  for (const cpu of cpuInfo) {
    for (const type in cpu.times) {
      totalTick += cpu.times[type]
    }
    totalIdle += cpu.times.idle
  }

  return {
    app: usage / 1000,
    used: (totalTick - totalIdle) / cpuInfo.length,
    total: totalTick / cpuInfo.length,
  }
}

function updateCpuUsage () {
  const newUsage = getCpuUsage()
  const totalDifference = newUsage.total - usage.total
  appRate = (newUsage.app - usage.app) / totalDifference
  usedRate = (newUsage.used - usage.used) / totalDifference
}

export interface Rate {
  app: number
  total: number
}

export interface Status {
  apps: AppStatus[]
  userCount: number
  groupCount: number
  memory: Rate
  cpu: Rate
  timestamp: number
  startTime: number
}

export interface AppStatus {
  label?: string
  selfId: number
  code: number
  rate?: number
}

type StatusModifier = (status: Status, config: StatusOptions) => void | Promise<void>
const statusModifiers: StatusModifier[] = []

export function extendStatus (callback: StatusModifier) {
  statusModifiers.push(callback)
}

async function _getStatus (config: StatusOptions, extend: boolean) {
  const [[[{ 'COUNT(*)': userCount }], [{ 'COUNT(*)': groupCount }]], apps] = await Promise.all([
    appList[0].database.mysql.query<[{ 'COUNT(*)': number }][]>([
      `SELECT COUNT(*) FROM \`user\` WHERE CURRENT_TIMESTAMP() - \`lastCall\` < 1000 * 3600 * 24`,
      `SELECT COUNT(*) FROM \`group\` WHERE \`assignee\``,
    ].join(';')),
    Promise.all(appList.map<Promise<AppStatus>>(async (app) => ({
      label: app.options.label,
      selfId: app.options.selfId,
      code: await app.sender.getStatus().then(status => status.good ? 0 : 1, () => 2),
      rate: (sendEventCounter.get(app) || []).slice(1).reduce((prev, curr) => prev + curr, 0),
    }))),
  ])
  const memory = memoryRate()
  const cpu = { app: appRate, total: usedRate }
  const status: Status = { apps, userCount, groupCount, memory, cpu, timestamp, startTime }
  if (extend) {
    await Promise.all(statusModifiers.map(modifier => modifier(status, config)))
  }
  return status
}

let cachedStatus: Promise<Status>
let timestamp: number

export async function getStatus (config: StatusOptions, extend = false): Promise<Status> {
  const now = Date.now()
  if (now - timestamp < 60000) return cachedStatus
  timestamp = now
  return cachedStatus = _getStatus(config, extend)
}

const startTime = Date.now()

const defaultConfig: StatusOptions = {
  sort: () => 0,
}

export default function apply (ctx: Context, config: StatusOptions) {
  const app = ctx.app
  config = { ...defaultConfig, ...config }

  app.on('before-command', ({ meta }) => {
    meta.$user['lastCall'] = new Date()
  })

  app.on('before-send', () => {
    const messages = sendEventCounter.get(app)
    messages[0] += 1
  })

  let timer: NodeJS.Timeout
  app.on('connect', () => {
    sendEventCounter.set(app, new Array(61).fill(0))
    timer = setInterval(() => {
      const messages = sendEventCounter.get(app)
      messages.unshift(0)
      messages.splice(-1, 1)
      updateCpuUsage()
    }, 1000)

    if (!app.server.router) return
    app.server.router.get('/status', async (ctx) => {
      const status = await getStatus(config, true).catch<Status>((error) => {
        appList[0].logger('status').warn(error)
        return null
      })
      if (!status) return ctx.status = 500
      ctx.set('Content-Type', 'application/json')
      ctx.set('Access-Control-Allow-Origin', '*')
      ctx.body = status
    })
  })

  app.on('before-disconnect', () => {
    clearInterval(timer)
  })

  ctx.command('status', '查看机器人运行状态')
    .shortcut('你的状态', { prefix: true })
    .shortcut('你的状况', { prefix: true })
    .shortcut('运行情况', { prefix: true })
    .shortcut('运行状态', { prefix: true })
    .action(async ({ meta }) => {
      const { apps, cpu, memory, startTime, userCount, groupCount } = await getStatus(config)

      const output = apps.sort(config.sort).map(({ label, selfId, code, rate }) => {
        return `${label || selfId}：${code ? '无法连接' : `工作中（${rate}/min）`}`
      })

      output.push('==========')

      output.push(
        `活跃用户数量：${userCount}`,
        `活跃群数量：${groupCount}`,
        `启动时间：${new Date(startTime).toLocaleString('zh-CN', { hour12: false })}`,
        `CPU 使用率：${(cpu.app * 100).toFixed()}% / ${(cpu.total * 100).toFixed()}%`,
        `内存使用率：${(memory.app * 100).toFixed()}% / ${(memory.total * 100).toFixed()}%`,
      )

      return meta.$send(output.join('\n'))
    })
}
