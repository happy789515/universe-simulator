export interface ScarPoint {
  x: number;
  y: number;
  z: number;
}

export interface BodySnapshot {
  id: string;
  epoch: number;
  eOffset: number;
  mOffset: number;
  scars: ScarPoint[];
}

export type SimAction =
  | { kind: "destroy"; planetId: string }
  | { kind: "restore"; planetId: string }
  | {
      kind: "impact";
      planetId: string;
      eOffset: number;
      mOffset: number;
      scarIndex: number;
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

  clear(): void {
    this.stack.length = 0;
  }

  get canUndo(): boolean {
    return this.stack.length > 0;
  }
}
