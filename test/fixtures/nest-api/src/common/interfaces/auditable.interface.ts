export interface Timestamped {
  createdAt: Date;
  updatedAt: Date;
}

export interface Auditable extends Timestamped {
  createdBy?: string;
  updatedBy?: string;
}
