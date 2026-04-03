import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable, delay, of } from 'rxjs';
import { environment } from '../../environments/environment';

export interface JobStatus {
  requestId: string;
  status: 'Queued' | 'Processing' | 'Completed' | 'Failed';
  progress: number;
  message?: string;
  outputPath?: string;
  outputBase64?: string;
  error?: { code: string; details: string };
}

export interface SubmitRequest {
  pricingModel: 'Zone-based' | 'Mileage-based' | 'Auto';
  input: { driveId: string; itemId: string; name: string; localFileBase64?: string };
  output: { localPath: string; fileName: string };
}

export interface SubmitResponse {
  requestId: string;
  status: string;
  statusUrl: string;
}

export interface BatchSubmitRequest {
  inputDir: string;
  outputDir: string;
  pricingModel: 'Zone-based' | 'Mileage-based' | 'Auto';
}

export interface BatchSubmitResponse {
  batchId: string;
  status: string;
  totalFiles: number;
  statusUrl: string;
  requestIds: string[];
}

export interface BatchItemStatus extends JobStatus {
  sourceFile?: string;
}

export interface BatchStatusResponse {
  batchId: string;
  status: 'Queued' | 'Processing' | 'Completed' | 'CompletedWithErrors' | 'Failed';
  inputDir: string;
  outputDir: string;
  pricingModel: 'Zone-based' | 'Mileage-based' | 'Auto';
  submittedAt: string;
  submittedBy: string;
  requestIds: string[];
  total: number;
  completed: number;
  failed: number;
  processing: number;
  queued: number;
  items: BatchItemStatus[];
  retryOfBatchId?: string;
}

export interface BatchFolderBrowseResponse {
  roots: string[];
  currentPath: string | null;
  parentPath: string | null;
  directories: string[];
}

export interface FolderPickRequest {
  title?: string;
  startPath?: string;
}

export interface FolderPickResponse {
  path: string | null;
  canceled: boolean;
}

type DemoRequestRecord = {
  requestId: string;
  createdAt: number;
  pricingModel: string;
  inputName: string;
  outputPath: string;
};

type DemoBatchRecord = {
  batchId: string;
  createdAt: number;
  inputDir: string;
  outputDir: string;
  pricingModel: 'Zone-based' | 'Mileage-based' | 'Auto';
  requestIds: string[];
};

const DEMO_REQUESTS_KEY = 'freight.demo.requests';
const DEMO_BATCHES_KEY = 'freight.demo.batches';

@Injectable({ providedIn: 'root' })
export class RequestsApiService {
  readonly baseUrl = environment.apiBaseUrl;

  constructor(private readonly http: HttpClient) {}

  private effectiveToken(token: string): string {
    const explicit = token?.trim();
    if (explicit) {
      return explicit;
    }

    if (typeof localStorage === 'undefined') {
      return '';
    }

    return localStorage.getItem('freight.auth.token') ?? '';
  }

  private buildHeaders(token: string): HttpHeaders {
    let headers = new HttpHeaders();
    const effective = this.effectiveToken(token);
    if (effective) {
      headers = headers.set('Authorization', `Bearer ${effective}`);
    }
    return headers;
  }

  submit(req: SubmitRequest, token: string): Observable<SubmitResponse> {
    if (environment.demoMode) {
      const requestId = `demo-${Date.now()}`;
      const outputPath = `demo://contract/${requestId}/${req.output.fileName}`;
      const record: DemoRequestRecord = {
        requestId,
        createdAt: Date.now(),
        pricingModel: req.pricingModel,
        inputName: req.input.name,
        outputPath,
      };
      this.writeDemoRequests([record, ...this.readDemoRequests()]);
      return of({
        requestId,
        status: 'Queued',
        statusUrl: `${this.baseUrl}/api/requests/${requestId}`,
      }).pipe(delay(450));
    }

    return this.http.post<SubmitResponse>(`${this.baseUrl}/api/requests`, req, {
      headers: this.buildHeaders(token),
    });
  }

  getStatus(requestId: string, token: string): Observable<JobStatus> {
    if (environment.demoMode) {
      return of(this.getDemoRequestStatus(requestId)).pipe(delay(300));
    }

    return this.http.get<JobStatus>(`${this.baseUrl}/api/requests/${requestId}`, {
      headers: this.buildHeaders(token),
    });
  }

  submitBatch(req: BatchSubmitRequest, token: string): Observable<BatchSubmitResponse> {
    if (environment.demoMode) {
      const batchId = `batch-${Date.now()}`;
      const requestIds = [
        `demo-${Date.now()}-1`,
        `demo-${Date.now()}-2`,
        `demo-${Date.now()}-3`,
      ];
      const createdAt = Date.now();

      const requests = this.readDemoRequests();
      const newRequests = requestIds.map((requestId, index) => ({
        requestId,
        createdAt,
        pricingModel: req.pricingModel,
        inputName: `Sample_${index + 1}.xlsx`,
        outputPath: `demo://contract/${requestId}/Sample_${index + 1}_Contract.docx`,
      } satisfies DemoRequestRecord));
      this.writeDemoRequests([...newRequests, ...requests]);

      const batches = this.readDemoBatches();
      batches.unshift({
        batchId,
        createdAt,
        inputDir: req.inputDir,
        outputDir: req.outputDir,
        pricingModel: req.pricingModel,
        requestIds,
      });
      this.writeDemoBatches(batches);

      return of({
        batchId,
        status: 'Queued',
        totalFiles: requestIds.length,
        statusUrl: `${this.baseUrl}/api/batch/requests/${batchId}`,
        requestIds,
      }).pipe(delay(450));
    }

    return this.http.post<BatchSubmitResponse>(`${this.baseUrl}/api/batch/requests`, req, {
      headers: this.buildHeaders(token),
    });
  }

  getBatchStatus(batchId: string, token: string): Observable<BatchStatusResponse> {
    if (environment.demoMode) {
      return of(this.getDemoBatchStatus(batchId)).pipe(delay(300));
    }

    return this.http.get<BatchStatusResponse>(`${this.baseUrl}/api/batch/requests/${batchId}`, {
      headers: this.buildHeaders(token),
    });
  }

  browseBatchFolders(pathValue: string | null, token: string): Observable<BatchFolderBrowseResponse> {
    const encoded = pathValue ? `?path=${encodeURIComponent(pathValue)}` : '';
    return this.http.get<BatchFolderBrowseResponse>(`${this.baseUrl}/api/batch/folders${encoded}`, {
      headers: this.buildHeaders(token),
    });
  }

    listFolders(path: string, token: string): Observable<BatchFolderBrowseResponse> {
      const encoded = path ? `?path=${encodeURIComponent(path)}` : '';
      return this.http.get<BatchFolderBrowseResponse>(`${this.baseUrl}/api/batch/folders${encoded}`, {
        headers: this.buildHeaders(token),
      });
    }

  pickFolder(req: FolderPickRequest, token: string): Observable<FolderPickResponse> {
    if (environment.demoMode) {
      return of({
        path: req.startPath ?? 'C:\\output',
        canceled: false,
      }).pipe(delay(250));
    }

    return this.http.post<FolderPickResponse>(`${this.baseUrl}/api/system/pick-folder`, req, {
      headers: this.buildHeaders(token),
    });
  }

  retryFailedBatch(batchId: string, token: string): Observable<BatchSubmitResponse> {
    if (environment.demoMode) {
      const newBatchId = `batch-${Date.now()}`;
      const requestIds = [`demo-${Date.now()}-retry`];
      const batches = this.readDemoBatches();
      const prior = batches.find((item) => item.batchId === batchId);
      batches.unshift({
        batchId: newBatchId,
        createdAt: Date.now(),
        inputDir: prior?.inputDir ?? 'C:\\Input',
        outputDir: prior?.outputDir ?? 'C:\\output',
        pricingModel: prior?.pricingModel ?? 'Auto',
        requestIds,
      });
      this.writeDemoBatches(batches);
      return of({
        batchId: newBatchId,
        status: 'Queued',
        totalFiles: 1,
        statusUrl: `${this.baseUrl}/api/batch/requests/${newBatchId}`,
        requestIds,
      }).pipe(delay(300));
    }

    return this.http.post<BatchSubmitResponse>(`${this.baseUrl}/api/batch/requests/${batchId}/retry-failed`, {}, {
      headers: this.buildHeaders(token),
    });
  }

  private getDemoRequestStatus(requestId: string): JobStatus {
    const record = this.readDemoRequests().find((item) => item.requestId === requestId);
    if (!record) {
      return {
        requestId,
        status: 'Failed',
        progress: 0,
        message: 'Demo request not found.',
      };
    }

    const elapsed = Date.now() - record.createdAt;
    if (elapsed < 4000) {
      return {
        requestId,
        status: 'Queued',
        progress: 15,
        message: 'Queued in demo pipeline.',
      };
    }

    if (elapsed < 10000) {
      return {
        requestId,
        status: 'Processing',
        progress: 70,
        message: 'Generating contract from sample workbook data (demo mode).',
      };
    }

    return {
      requestId,
      status: 'Completed',
      progress: 100,
      message: 'Contract generated successfully (demo mode).',
      outputPath: record.outputPath,
    };
  }

  private getDemoBatchStatus(batchId: string): BatchStatusResponse {
    const batch = this.readDemoBatches().find((item) => item.batchId === batchId);
    const nowIso = new Date().toISOString();
    if (!batch) {
      return {
        batchId,
        status: 'Failed',
        inputDir: 'C:\\Input',
        outputDir: 'C:\\output',
        pricingModel: 'Auto',
        submittedAt: nowIso,
        submittedBy: 'demo.user',
        requestIds: [],
        total: 0,
        completed: 0,
        failed: 0,
        processing: 0,
        queued: 0,
        items: [],
      };
    }

    const elapsed = Date.now() - batch.createdAt;
    const statuses = batch.requestIds.map((requestId, index) => {
      const base = this.getDemoRequestStatus(requestId);
      return {
        ...base,
        sourceFile: `Sample_${index + 1}.xlsx`,
      };
    });

    const completed = statuses.filter((item) => item.status === 'Completed').length;
    const failed = statuses.filter((item) => item.status === 'Failed').length;
    const processing = statuses.filter((item) => item.status === 'Processing').length;
    const queued = statuses.filter((item) => item.status === 'Queued').length;

    const status: BatchStatusResponse['status'] =
      elapsed > 10000 ? (failed > 0 ? 'CompletedWithErrors' : 'Completed') : 'Processing';

    return {
      batchId: batch.batchId,
      status,
      inputDir: batch.inputDir,
      outputDir: batch.outputDir,
      pricingModel: batch.pricingModel,
      submittedAt: new Date(batch.createdAt).toISOString(),
      submittedBy: 'demo.user',
      requestIds: batch.requestIds,
      total: batch.requestIds.length,
      completed,
      failed,
      processing,
      queued,
      items: statuses,
    };
  }

  private readDemoRequests(): DemoRequestRecord[] {
    if (typeof localStorage === 'undefined') {
      return [];
    }

    const raw = localStorage.getItem(DEMO_REQUESTS_KEY);
    if (!raw) {
      return [];
    }

    try {
      const parsed = JSON.parse(raw) as DemoRequestRecord[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private writeDemoRequests(records: DemoRequestRecord[]): void {
    if (typeof localStorage === 'undefined') {
      return;
    }
    localStorage.setItem(DEMO_REQUESTS_KEY, JSON.stringify(records.slice(0, 100)));
  }

  private readDemoBatches(): DemoBatchRecord[] {
    if (typeof localStorage === 'undefined') {
      return [];
    }

    const raw = localStorage.getItem(DEMO_BATCHES_KEY);
    if (!raw) {
      return [];
    }

    try {
      const parsed = JSON.parse(raw) as DemoBatchRecord[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private writeDemoBatches(records: DemoBatchRecord[]): void {
    if (typeof localStorage === 'undefined') {
      return;
    }
    localStorage.setItem(DEMO_BATCHES_KEY, JSON.stringify(records.slice(0, 30)));
  }
}
