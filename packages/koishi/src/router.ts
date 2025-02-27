import { App, Context, Schema } from '@koishijs/core'
import { defineProperty, MaybeArray, remove } from '@koishijs/utils'
import { createServer, IncomingMessage, Server } from 'http'
import { pathToRegexp } from 'path-to-regexp'
import parseUrl from 'parseurl'
import WebSocket from 'ws'
import KoaRouter from '@koa/router'
import Koa from 'koa'

declare module 'koa' {
  // koa-bodyparser
  interface Request {
    body?: any
    rawBody?: string
  }
}

declare module '@koishijs/core' {
  interface App {
    _httpServer?: Server
    _wsServer?: WebSocket.Server
  }

  namespace App {
    interface Config extends Config.Network {}

    namespace Config {
      interface Static {
        Network: Schema<Network>
      }

      interface Network {
        host?: string
        port?: number
        selfUrl?: string
      }
    }
  }
}

defineProperty(App.Config, 'Network', Schema.object({
  host: Schema.string().default('localhost').description('要监听的 IP 地址。如果将此设置为 `0.0.0.0` 将监听所有地址，包括局域网和公网地址。'),
  port: Schema.natural().max(65535).description('要监听的端口。'),
  selfUrl: Schema.string().role('url').description('应用暴露在公网的地址。部分插件 (例如 github 和 telegram) 需要用到。'),
}).description('网络设置'))

type WebSocketCallback = (socket: WebSocket, request: IncomingMessage) => void

export class WebSocketLayer {
  clients = new Set<WebSocket>()
  regexp: RegExp

  constructor(private router: Router, path: MaybeArray<string | RegExp>, public callback?: WebSocketCallback) {
    this.regexp = pathToRegexp(path)
  }

  accept(socket: WebSocket, request: IncomingMessage) {
    if (!this.regexp.test(parseUrl(request).pathname)) return
    this.clients.add(socket)
    socket.on('close', () => {
      this.clients.delete(socket)
    })
    this.callback?.(socket, request)
    return true
  }

  close() {
    remove(this.router.wsStack, this)
    for (const socket of this.clients) {
      socket.close()
    }
  }
}

export class Router extends KoaRouter {
  wsStack: WebSocketLayer[] = []

  /**
   * hack into router methods to make sure that koa middlewares are disposable
   */
  register(...args: Parameters<KoaRouter['register']>) {
    const layer = super.register(...args)
    const context: Context = this[Context.current]
    context?.state.disposables.push(() => {
      remove(this.stack, layer)
    })
    return layer
  }

  ws(path: MaybeArray<string | RegExp>, callback?: WebSocketCallback) {
    const layer = new WebSocketLayer(this, path, callback)
    this.wsStack.push(layer)
    const context: Context = this[Context.current]
    context?.state.disposables.push(() => {
      remove(this.wsStack, layer)
    })
    return layer
  }

  static prepare(app: App) {
    // create server
    const koa = new Koa()
    app.router = new Router()
    koa.use(require('koa-bodyparser')())
    koa.use(app.router.routes())
    koa.use(app.router.allowedMethods())

    app._httpServer = createServer(koa.callback())
    app._wsServer = new WebSocket.Server({
      server: app._httpServer,
    })

    app._wsServer.on('connection', (socket, request) => {
      for (const manager of app.router.wsStack) {
        if (manager.accept(socket, request)) return
      }
      socket.close()
    })
  }
}
