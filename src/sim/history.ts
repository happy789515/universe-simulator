export interface ScarPoint {
  x: number;
  y: number;
  z: number;
}

export type DeathAct = "blackhole" | "laser";

export interface BodySnapshot {
  id: string;
  epoch: number;
  eOffset: number;
  mOffset: number;
  scars: ScarPoint[];
  death: DeathAct | null;
}

export type SimAction =
  | { kind: "destroy"; planetId: string; act: DeathAct }
  | { kind: "restore"; planetId: string; act: DeathAct }
  | {
      kind: "impact";
      planetId: string;
      eOffset: number;
      mOffset: number;
      scarIndex: number;
      fast: boolean;
    }
  | {
      kind: "reset";
      destroyedIds: string[];
      simDays: number;
      bodies: BodySnapshot[];
    };

export class HistoryStack {
  private readonly stack: SimAction[] = [];

  push(action: SimAction): void {
    this.stack.push(action);
  }

  pop(): SimAction | undefined {
    return this.stack.pop();
  }

  peek(): SimAction | undefined {
    return this.stack[this.stack.length - 1];
  }

  clear(): void {
    this.stack.length = 0;
  }

  get canUndo(): boolean {
    return this.stack.length > 0;
  }
}
