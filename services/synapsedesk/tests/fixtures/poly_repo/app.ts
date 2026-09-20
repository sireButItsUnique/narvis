import { helper } from "./lib";

export function start(): void {
  helper();
  missing();
}

export class Runner {
  run() {
    start();
  }
}
