import { connect } from 'node:net';

/**
 * net.Socket → SSHSession 所需的 socket 形状适配器。
 * 与 cloudflare:sockets connect() 返回值结构等价：
 * { readable, writable, opened, close() }。
 */
export interface AgentSocket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  opened: Promise<void>;
  close(): void;
}

export function createAgentSocket(host: string, port: number): AgentSocket {
  const socket = connect({ host, port });
  socket.setNoDelay(true);

  const opened = new Promise<void>((resolve, reject) => {
    const onConnect = () => {
      cleanup();
      resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      socket.off('connect', onConnect);
      socket.off('error', onError);
    };
    socket.once('connect', onConnect);
    socket.once('error', onError);
  });
  // 未消费的 rejection 会触发 unhandledRejection；连接失败经 reader/writer 错误路径上报。
  opened.catch(() => undefined);

  let closed = false;
  const closeSocket = () => {
    if (closed) return;
    closed = true;
    try {
      socket.destroy();
    } catch {
      /* already destroyed */
    }
  };

  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      socket.on('data', (chunk: Buffer) => {
        // backpressure：desiredSize 耗尽即暂停，下一次 pull 恢复
        if (controller.desiredSize !== null && controller.desiredSize <= 0) {
          socket.pause();
        }
        controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      });
      socket.on('end', () => {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
      socket.on('error', (err) => {
        try {
          controller.error(err);
        } catch {
          /* already errored */
        }
      });
      socket.on('close', () => {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
    pull() {
      socket.resume();
    },
    cancel() {
      closeSocket();
    },
  });

  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        if (closed || socket.destroyed) {
          reject(new Error('Socket closed'));
          return;
        }
        // 回调在数据写入内核缓冲后触发：该信号即本层的背压边界。
        socket.write(chunk, (err?: Error | null) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
    close() {
      closeSocket();
    },
    abort() {
      closeSocket();
    },
  });

  return {
    readable,
    writable,
    opened,
    close: closeSocket,
  };
}
