import fs from 'fs';
import path from 'path';
import { prisma } from '../lib/prisma.js';

export interface RetentionPolicyConfig {
  proctoringSnapshotRetentionDays: number;
  candidateDataRetentionDays: number;
}

export class RetentionService {
  /**
   * Get effective retention policy for a tenant
   */
  static async getTenantRetentionPolicy(companyId: string): Promise<RetentionPolicyConfig> {
    const defaults: RetentionPolicyConfig = {
      proctoringSnapshotRetentionDays: 30, // 30 days default for webcam media
      candidateDataRetentionDays: 180,     // 180 days default
    };

    try {
      const company = await prisma.company.findUnique({
        where: { id: companyId },
        select: { settingsJson: true },
      });

      if (company?.settingsJson) {
        const parsed = JSON.parse(company.settingsJson);
        if (parsed.proctoringSnapshotRetentionDays) {
          defaults.proctoringSnapshotRetentionDays = Math.max(7, Number(parsed.proctoringSnapshotRetentionDays));
        }
        if (parsed.candidateDataRetentionDays) {
          defaults.candidateDataRetentionDays = Math.max(30, Number(parsed.candidateDataRetentionDays));
        }
      }
    } catch {}

    return defaults;
  }

  /**
   * Purge expired proctoring snapshots from disk for a tenant.
   * MANDATORY EXCEPTION: Excludes all candidate applications marked with legalHold: true.
   */
  static async purgeExpiredSnapshots(
    companyId: string,
    overrideDays?: number
  ): Promise<{ success: boolean; purgedCount: number; thresholdDate: Date; legalHoldSkippedCount: number }> {
    const policy = await this.getTenantRetentionPolicy(companyId);
    const retentionDays = overrideDays !== undefined ? overrideDays : policy.proctoringSnapshotRetentionDays;
    const thresholdDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

    // 1. Find all applications under active legal hold for this tenant
    const legalHoldApps = await prisma.jobApplication.findMany({
      where: {
        job: { companyId },
        legalHold: true,
      },
      select: { id: true, candidateId: true },
    });
    const protectedIds = new Set([
      ...legalHoldApps.map(a => a.id),
      ...legalHoldApps.map(a => a.candidateId),
    ]);

    // 2. Find eligible attempts completed before thresholdDate where application is NOT under legal hold
    const expiredAttempts = await prisma.assessmentAttempt.findMany({
      where: {
        application: {
          job: { companyId },
          legalHold: false,
        },
        startedAt: { lt: thresholdDate },
      },
      select: {
        id: true,
        applicationId: true,
      },
    });

    let purgedCount = 0;
    const baseUploadsDir = process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME
      ? path.join('/tmp', 'uploads')
      : path.join(process.cwd(), 'uploads');
    const tenantProctoringDir = path.resolve(baseUploadsDir, 'tenants', companyId, 'proctoring');

    if (fs.existsSync(tenantProctoringDir)) {
      try {
        const files = fs.readdirSync(tenantProctoringDir);
        for (const file of files) {
          // Verify file does not belong to any protected legal-hold application
          let isProtected = false;
          for (const protectedId of protectedIds) {
            if (file.includes(protectedId)) {
              isProtected = true;
              break;
            }
          }
          if (isProtected) continue;

          // Check if file belongs to one of the expired attempts
          for (const attempt of expiredAttempts) {
            if (file.includes(attempt.id) || file.includes(attempt.applicationId)) {
              const fullPath = path.join(tenantProctoringDir, file);
              if (fs.existsSync(fullPath)) {
                try {
                  fs.unlinkSync(fullPath);
                  purgedCount++;
                } catch (err) {
                  console.warn(`[RETENTION PURGE] Failed to unlink ${file}:`, err);
                }
              }
              break;
            }
          }
        }
      } catch (err) {
        console.error('[RETENTION PURGE] Error reading tenant proctoring directory:', err);
      }
    }

    // 3. Log purge action in tamper-resistant AuditLog
    await prisma.auditLog.create({
      data: {
        companyId,
        action: 'RETENTION_PURGE_EXECUTED',
        entity: 'ProctoringMedia',
        details: JSON.stringify({
          companyId,
          retentionDays,
          thresholdDate: thresholdDate.toISOString(),
          purgedSnapshotsCount: purgedCount,
          legalHoldSkippedCount: legalHoldApps.length,
          executedAt: new Date().toISOString(),
        }),
      },
    });

    return {
      success: true,
      purgedCount,
      thresholdDate,
      legalHoldSkippedCount: legalHoldApps.length,
    };
  }
}
