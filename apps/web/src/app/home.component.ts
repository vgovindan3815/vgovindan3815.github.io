import { ChangeDetectorRef, Component, inject, NgZone, OnDestroy, OnInit } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Router, RouterLink } from '@angular/router';
import { Subscription, switchMap, takeWhile, timeout, timer } from 'rxjs';
import { firstValueFrom } from 'rxjs';
import { environment } from '../environments/environment';

import { AuthService } from './services/auth.service';
import { ExcelValidationService } from './services/excel-validation.service';
import { JobStatus, RequestsApiService } from './services/requests-api.service';

export type PricingModel = 'Zone-based' | 'Mileage-based';

@Component({
  selector: 'app-home',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressBarModule,
    MatSelectModule,
    MatTooltipModule,
    RouterLink
  ],
  templateUrl: './home.component.html',
  styleUrl: './home.component.scss',
})
export class HomeComponent implements OnInit, OnDestroy {
  private readonly auth = inject(AuthService);
  private readonly http = inject(HttpClient);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly excelValidator = inject(ExcelValidationService);
  private readonly zone = inject(NgZone);
  private readonly requestsApi = inject(RequestsApiService);
  private readonly router = inject(Router);

  // ── Form state ────────────────────────────────────────────────────────────
  pricingModel: PricingModel | null = null;
  inputFile?: { driveId: string; itemId: string; name: string; localFileBase64?: string };
  localExcelFile?: File;
  outputDirPath: string | null = null;
  readonly defaultOutputPath = 'C:\\output';
  outputFileName = '';

  // ── UI state ──────────────────────────────────────────────────────────────
  validating = false;
  validationError: string | null = null;
  validationSuccess: string | null = null;
  validationDurationMs: number | null = null;
  validationSlowWarning: string | null = null;
  submitting = false;
  currentRequest: JobStatus | null = null;

  private pollSub?: Subscription;

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────
  ngOnInit(): void {
    // No-op.
  }

  ngOnDestroy(): void {
    this.pollSub?.unsubscribe();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Computed
  // ─────────────────────────────────────────────────────────────────────────
  get signedInUser(): string {
    return this.auth.getAccount()?.username ?? '';
  }

  get canSubmit(): boolean {
    return (
      !!this.pricingModel &&
      !!this.inputFile &&
      !!this.outputFileName.trim() &&
      !this.validationError &&
      !this.validating &&
      !this.submitting
    );
  }

  get outputFolderDisplayPath(): string {
    return this.outputDirPath ?? this.defaultOutputPath;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Event handlers
  // ─────────────────────────────────────────────────────────────────────────
  onPricingModelChange(): void {
    if (this.localExcelFile) {
      void this.validateTemplate();
    }
  }

  openLocalFilePicker(fileInput: HTMLInputElement): void {
    try {
      const pickerInput = fileInput as HTMLInputElement & {
        showPicker?: () => void;
      };
      if (typeof pickerInput.showPicker === 'function') {
        pickerInput.showPicker();
      } else {
        fileInput.click();
      }
    } catch {
      fileInput.click();
    }
  }

  async onLocalFileSelected(event: Event): Promise<void> {
    const target = event.target as HTMLInputElement;
    const selected = target.files?.[0];
    if (!selected) return;

    if (!selected.name.toLowerCase().endsWith('.xlsx')) {
      this.validationError = 'Only .xlsx files are supported.';
      return;
    }

    this.localExcelFile = selected;
    this.inputFile = {
      driveId: 'local',
      itemId: `local-${Date.now()}`,
      name: selected.name,
    };
    this.validationError = null;
    this.validationSuccess = null;
    this.validationDurationMs = null;
    this.validationSlowWarning = null;
    this.suggestOutputFileName();

    if (this.pricingModel) {
      await this.validateTemplate();
    }
  }

  async openFolderBrowser(): Promise<void> {
    try {
      const response = await firstValueFrom(
        this.requestsApi
          .pickFolder(
            {
              title: 'Select output folder',
              startPath: this.outputDirPath ?? this.defaultOutputPath,
            },
            '',
          )
          .pipe(timeout(130000)),
      );

      if (response.path) {
        this.outputDirPath = response.path;
      }

      this.validationError = null;
    } catch {
      this.validationError = 'Failed to open the native Windows folder picker. You can still enter the folder path manually.';
    }
  }
  async submit(): Promise<void> {
    if (!this.canSubmit) return;

    if (!this.localExcelFile || !this.inputFile) {
      this.validationError = 'Please select a local Excel file first.';
      return;
    }

    this.submitting = true;
    this.currentRequest = {
      requestId: '',
      status: 'Queued',
      progress: 0,
      message: 'Submitting request...',
    };
    this.cdr.detectChanges();

    try {
      const localFileBase64 = await this.readFileAsBase64(this.localExcelFile);
      const response = await firstValueFrom(
        this.requestsApi.submit(
          {
            pricingModel: this.pricingModel!,
            input: {
              driveId: this.inputFile.driveId,
              itemId: this.inputFile.itemId,
              name: this.inputFile.name,
              localFileBase64,
            },
            output: {
              localPath: this.outputDirPath ?? this.defaultOutputPath,
              fileName: this.outputFileName.trim(),
            },
          },
          '',
        ),
      );

      this.zone.run(() => {
        this.currentRequest = {
          requestId: response.requestId,
          status: 'Queued',
          progress: 0,
          message: 'Request queued for processing',
        };
        this.startPolling(response.requestId);
        this.cdr.detectChanges();
      });
    } catch (err) {
      console.error('[HomeComponent] Submit failed', err);
      const httpErr = err as { status?: number; error?: { error?: string } };
      const detail =
        httpErr?.error?.error ||
        (httpErr?.status === 413 ? 'Excel file too large to send. Please contact support.' : null) ||
        (httpErr?.status === 0 ? 'Cannot reach the Freight API. Start it from the Wrapper controls.' : null) ||
        'Submission failed. Please try again.';
      this.zone.run(() => {
        this.currentRequest = {
          requestId: '',
          status: 'Failed',
          progress: 0,
          message: detail,
        };
        this.cdr.detectChanges();
      });
    } finally {
      this.zone.run(() => {
        this.submitting = false;
        this.cdr.detectChanges();
      });
    }
  }

  logout(): void {
    this.auth.logout();
    void this.router.navigateByUrl('/login');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────
  private suggestOutputFileName(): void {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const baseName = this.inputFile?.name.replace(/\.xlsx$/i, '') ?? 'Contract';
    this.outputFileName = `${baseName}_Contract_${ts}.docx`;
  }

  private async validateTemplate(): Promise<void> {
    if (!this.localExcelFile || !this.pricingModel) return;

    const traceId = `val-${Date.now()}`;
    const startedAt = performance.now();
    this.validating = true;
    this.validationError = null;
    this.validationSuccess = null;
    this.validationDurationMs = null;
    this.validationSlowWarning = null;
    this.trace(`${traceId} validation start | file=${this.localExcelFile.name} | size=${this.localExcelFile.size} bytes | model=${this.pricingModel}`);
    try {
      const buffer = await Promise.race<ArrayBuffer>([
        this.localExcelFile.arrayBuffer(),
        new Promise<ArrayBuffer>((_, reject) =>
          setTimeout(() => reject(new Error('Timed out reading selected file.')), 15000),
        ),
      ]);
      this.trace(`${traceId} file read complete | bytes=${buffer.byteLength}`);

      const result = await this.excelValidator.validateBufferAsync(buffer, this.pricingModel, 15000);
      this.trace(`${traceId} worker returned | timedOut=${String(result.timedOut)} | hasError=${String(!!result.error)}`);
      this.zone.run(() => {
        if (result.timedOut) {
          this.validationSuccess =
            'Validation timed out locally; proceeding. Server-side validation will continue.';
          this.validationSlowWarning =
            'Validation exceeded 15s. This file may be large/complex for local parsing.';
        } else if (result.error) {
          this.validationError = result.error;
        } else {
          this.validationSuccess = `✅ Template validated — pricing model matches "${this.pricingModel}".`;
        }
      });
    } catch (err) {
      this.zone.run(() => {
        this.validationError = 'Could not read the file. Please ensure it is a valid .xlsx file.';
      });
      this.trace(`${traceId} validation error | ${(err as Error)?.message ?? 'unknown error'}`);
      console.error(`[${traceId}] Validation error`, err);
    } finally {
      this.zone.run(() => {
        this.validationDurationMs = Math.round(performance.now() - startedAt);
        if (this.validationDurationMs > 2000) {
          this.validationSlowWarning =
            'Large Excel file detected. Validation may take longer on this device.';
        }
        this.validating = false;
        this.trace(
          `${traceId} validation end | duration=${this.validationDurationMs}ms | hasError=${String(!!this.validationError)} | hasSuccess=${String(!!this.validationSuccess)}`,
        );
        this.cdr.detectChanges();
      });
    }
  }

  private trace(message: string): void {
    console.log(`[validation-trace] ${message}`);
  }

  private readFileAsBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        if (typeof result !== 'string') {
          reject(new Error('Could not read selected file'));
          return;
        }
        const base64 = result.split(',')[1] ?? '';
        resolve(base64);
      };
      reader.onerror = () => reject(reader.error ?? new Error('File read failed'));
      reader.readAsDataURL(file);
    });
  }

  openDocument(): void {
    const p = this.currentRequest?.outputPath;
    if (!p) return;

    if (environment.demoMode && p.startsWith('demo://')) {
      const fileName = this.outputFileName.trim() || 'contract.docx';
      const content = [
        'Freight Contract Generator - Demo Output',
        '',
        `Request ID: ${this.currentRequest?.requestId ?? 'N/A'}`,
        `Pricing Model: ${this.pricingModel ?? 'N/A'}`,
        `Generated At: ${new Date().toISOString()}`,
        '',
        'This file was generated by the GitHub Pages prototype demo mode.',
      ].join('\r\n');
      const blob = new Blob([content], {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      });
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(objectUrl), 10000);
      return;
    }

    const encoded = encodeURIComponent(p);
    const url = `${this.requestsApi.baseUrl}/api/file?path=${encoded}`;
    const fileName = this.outputFileName.trim() || 'contract.docx';
    this.auth.getToken().then((token) => {
      this.http
        .get(url, {
          responseType: 'blob',
          headers: { Authorization: `Bearer ${token ?? ''}` },
        })
        .subscribe((blob) => {
          const objectUrl = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = objectUrl;
          a.download = fileName;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          setTimeout(() => URL.revokeObjectURL(objectUrl), 10000);
        });
    });
  }

  private startPolling(requestId: string): void {
    this.pollSub?.unsubscribe();
    this.pollSub = timer(0, 15000)
      .pipe(
        switchMap(() => this.requestsApi.getStatus(requestId, '')),
        takeWhile((s) => s.status !== 'Completed' && s.status !== 'Failed', true),
      )
      .subscribe({
        next: (status) => {
          this.zone.run(() => {
            this.currentRequest = status;
            this.cdr.detectChanges();
          });
        },
        error: (err) => {
          console.error('[HomeComponent] Poll error', err);
          this.zone.run(() => {
            this.currentRequest = {
              requestId,
              status: 'Failed',
              progress: 0,
              message: 'Failed to poll request status.',
            };
            this.submitting = false;
            this.cdr.detectChanges();
          });
        },
      });
  }
}
