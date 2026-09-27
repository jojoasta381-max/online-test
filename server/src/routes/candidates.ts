import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { prisma } from '../lib/prisma.js';
import { ResumeMatchingService } from '../services/ResumeMatchingService.js';
import { EmailService } from '../services/EmailService.js';
import { NotificationService } from '../services/NotificationService.js';
import { storageService } from '../services/StorageService.js';
import { authenticateToken, optionalAuth, requireRole, AuthenticatedRequest } from '../middleware/auth.js';

export const candidatesRouter = Router();

// Configure Multer for Resume File Uploads
const baseUploadsDir = process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME
  ? path.join('/tmp', 'uploads')
  : path.join(process.cwd(), 'uploads');

const uploadDir = path.join(baseUploadsDir, 'resumes');
try {
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }
} catch (err: any) {
  console.warn('[CANDIDATES] Warning creating uploadDir:', err.message);
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const uniqueSuffix = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
    cb(null, `resume-${uniqueSuffix}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB strict limit
  fileFilter: (_req, file, cb) => {
    const allowedExts = ['.pdf', '.docx', '.doc', '.txt'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedExts.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`File extension '${ext}' is not allowed. Only PDF, DOCX, and TXT files are supported.`));
    }
  }
});

export const handleResumeUpload = (req: any, res: any, next: any) => {
  upload.single('resume')(req, res, (err: any) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ success: false, error: 'File size exceeds maximum allowed limit of 5MB.' });
      }
      return res.status(400).json({ success: false, error: err.message || 'File upload failed.' });
    }
    next();
  });
};

/**
 * List Candidate Applications with filters (Authenticated & Scoped)
 */
candidatesRouter.get('/', authenticateToken, requireRole(['RECRUITER', 'HR_ADMIN', 'ADMIN', 'TECH_INTERVIEWER']), async (req: AuthenticatedRequest, res) => {
  const { jobId, status, search } = req.query;

  try {
    const isSuperAdmin = req.user?.role === 'ADMIN' && !req.user?.companyId;
    const whereClause: any = {};
    if (!isSuperAdmin) {
      whereClause.job = { companyId: req.user?.companyId || undefined };
    }
    if (jobId) whereClause.jobId = String(jobId);
    if (status && status !== 'ALL') whereClause.status = String(status);

    if (search) {
      whereClause.candidate = {
        OR: [
          { name: { contains: String(search), mode: 'insensitive' } },
          { email: { contains: String(search), mode: 'insensitive' } },
        ]
      };
    }

    const applications = await prisma.jobApplication.findMany({
      where: whereClause,
      include: {
        candidate: true,
        job: {
          include: { company: true }
        },
        attempts: {
          orderBy: { startedAt: 'desc' },
          take: 1,
          include: { result: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    const formatted = await Promise.all(applications.map(async (app) => {
      const latestAttempt = app.attempts[0];
      const result = latestAttempt?.result;

      // Extract skills & match if not yet saved
      let jobSkills: string[] = [];
      try {
        jobSkills = JSON.parse(app.job.skillsRequired || '[]');
      } catch {
        jobSkills = ['Git', 'Linux', 'Docker', 'Kubernetes', 'CI/CD'];
      }

      let resumeMatchScore = app.resumeMatchScore;
      let matchedSkills: string[] = [];
      if (app.resumeParsedSkills) {
        try {
          matchedSkills = JSON.parse(app.resumeParsedSkills);
        } catch {}
      }

      if ((resumeMatchScore === null || resumeMatchScore === undefined || resumeMatchScore === 0) && app.candidate.resumeUrl) {
        const fullPath = storageService.resolveLocalPath(app.candidate.resumeUrl);
        if (fs.existsSync(fullPath)) {
          try {
            const evalRes = await ResumeMatchingService.parseAndEvaluateResumeFile(
              fullPath,
              jobSkills,
              app.candidate.name
            );
            if (evalRes.matchScore > 0 || evalRes.matchedSkills.length > 0) {
              resumeMatchScore = evalRes.matchScore;
              matchedSkills = evalRes.matchedSkills;
              await prisma.jobApplication.update({
                where: { id: app.id },
                data: {
                  resumeMatchScore: evalRes.matchScore,
                  resumeParsedSkills: JSON.stringify(evalRes.matchedSkills),
                }
              }).catch(() => {});
            }
          } catch {}
        }
      }

      if (resumeMatchScore === null || resumeMatchScore === undefined) {
        const candidateResumeText = app.resumeParsedText || '';
        const evalRes = ResumeMatchingService.evaluateResumeMatch(
          candidateResumeText,
          jobSkills
        );
        resumeMatchScore = evalRes.matchScore;
        matchedSkills = evalRes.matchedSkills;
      }

      const techScore = result ? Math.round(result.percentage) : null;
      const riskScore = latestAttempt?.proctoringRiskScore ?? (latestAttempt ? Math.max(0, 100 - latestAttempt.integrityScore) : 0);
      const riskLevel = latestAttempt?.proctoringRiskLevel || (riskScore >= 61 ? 'HIGH' : riskScore >= 31 ? 'MEDIUM' : 'LOW');

      let rankingScore = app.rankingScore;
      let recommendation = app.recommendation;

      if (rankingScore === null || rankingScore === undefined) {
        const rank = ResumeMatchingService.calculateCandidateRanking({
          technicalScore: techScore,
          resumeMatchScore: resumeMatchScore ?? 0,
          proctoringRiskScore: riskScore,
          passThreshold: app.job.passThreshold,
          currentStatus: app.status,
        });
        rankingScore = rank.rankingScore;
        recommendation = rank.recommendation;
      }

      return {
        id: app.id,
        applicationId: app.id,
        candidateId: app.candidate.id,
        name: app.candidate.name,
        email: app.candidate.email,
        phone: app.candidate.phone,
        resumeUrl: (app.resumeUrl || app.candidate.resumeUrl) ? `/api/candidates/${app.id}/resume` : null,
        resumeFileName: app.resumeFileName || app.candidate.resumeFileName,
        jobId: app.jobId,
        jobTitle: app.job.title,
        status: app.status,
        token: app.token,
        tokenExpiresAt: app.tokenExpiresAt,
        scorePercentage: techScore,
        isPassed: result ? result.isPassed : null,
        proctoringRisk: riskLevel,
        proctoringRiskScore: riskScore,
        resumeMatchScore: resumeMatchScore !== null && resumeMatchScore !== undefined ? Math.round(resumeMatchScore) : null,
        matchedSkills,
        rankingScore: rankingScore !== null && rankingScore !== undefined ? Math.round(rankingScore * 10) / 10 : null,
        recommendation,
        createdAt: app.createdAt,
        appliedAt: app.createdAt,
        job: {
          id: app.job.id,
          title: app.job.title,
          location: app.job.location,
          experienceRange: app.job.experienceRange,
          passThreshold: app.job.passThreshold,
          skillsRequired: jobSkills,
        },
        attempts: app.attempts.map(att => ({
          id: att.id,
          integrityScore: att.integrityScore,
          proctoringRiskScore: att.proctoringRiskScore,
          proctoringRiskLevel: att.proctoringRiskLevel,
          tabSwitchCount: att.tabSwitchCount,
          fullscreenViolationCount: att.fullscreenViolationCount,
          screenShareStopCount: att.screenShareStopCount,
          cameraDisconnectCount: att.cameraDisconnectCount,
          result: att.result ? {
            score: att.result.totalScore,
            totalPossible: att.result.maxScore,
            percentage: Math.round(att.result.percentage),
            isPassed: att.result.isPassed,
            integrityScore: att.result.integrityScore,
            proctoringRiskLevel: att.result.proctoringRiskLevel || (att.result.integrityScore < 60 ? 'HIGH' : att.result.integrityScore < 85 ? 'MEDIUM' : 'LOW'),
            proctoringRiskScore: att.result.proctoringRiskScore,
          } : null,
        }))
      };
    }));

    res.json({ success: true, candidates: formatted });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Candidate Detail view for Recruiter Inspection (Includes Proctoring & Coding Submissions)
 */
candidatesRouter.get('/detail/:applicationId', authenticateToken, requireRole(['RECRUITER', 'HR_ADMIN', 'ADMIN', 'TECH_INTERVIEWER']), async (req: AuthenticatedRequest, res) => {
  const { applicationId } = req.params;

  try {
    const application = await prisma.jobApplication.findUnique({
      where: { id: applicationId },
      include: {
        candidate: true,
        job: {
          include: {
            company: true,
            assessmentTemplate: true
          }
        },
        attempts: {
          orderBy: { startedAt: 'desc' },
          include: {
            result: true,
            answers: true,
            proctoringLogs: {
              orderBy: { timestamp: 'asc' }
            }
          }
        }
      }
    });

    if (!application) {
      return res.status(404).json({ success: false, error: 'Candidate application not found' });
    }

    const isSuperAdmin = req.user?.role === 'ADMIN' && !req.user?.companyId;
    if (!isSuperAdmin && req.user?.companyId && application.job.companyId !== req.user.companyId) {
      return res.status(403).json({ success: false, error: 'Forbidden: You do not have access to this candidate application.' });
    }

    const latestAttempt = application.attempts[0] || null;
    const result = latestAttempt?.result || null;
    const sectionScores = result ? JSON.parse(result.sectionScoresJson || '{}') : {};

    // Retrieve submitted coding answers
    let codeSubmissions: Array<{ questionPrompt: string; codeAnswer: string; sectionTitle?: string }> = [];
    if (latestAttempt && latestAttempt.answers.length > 0) {
      const codeAnswersList = latestAttempt.answers.filter(a => a.codeAnswer && a.codeAnswer.trim().length > 0);
      for (const ca of codeAnswersList) {
        const q = await prisma.question.findUnique({ where: { id: ca.questionId }, include: { section: true } });
        if (q) {
          codeSubmissions.push({
            questionPrompt: q.prompt,
            codeAnswer: ca.codeAnswer || '',
            sectionTitle: q.section?.title,
          });
        }
      }
    }

    // Build timeline of events
    const timeline = [
      { event: 'Candidate Applied', timestamp: application.createdAt },
      { event: 'Assessment Invited', timestamp: application.createdAt },
    ];

    if (application.isOtpVerified) {
      timeline.push({ event: 'OTP Verification Passed', timestamp: application.createdAt });
    }

    if (latestAttempt) {
      timeline.push({ event: 'Assessment Started', timestamp: latestAttempt.startedAt });
      
      for (const pLog of latestAttempt.proctoringLogs) {
        timeline.push({
          event: `Proctoring Alert: ${pLog.eventType.replace('_', ' ')}`,
          timestamp: pLog.timestamp,
        });
      }

      if (latestAttempt.submittedAt) {
        timeline.push({ event: 'Assessment Submitted', timestamp: latestAttempt.submittedAt });
        timeline.push({ event: `Evaluation Completed (${result?.isPassed ? 'PASSED' : 'FAILED'})`, timestamp: result?.evaluatedAt || latestAttempt.submittedAt });
      }
    }

    res.json({
      success: true,
      detail: {
        applicationId: application.id,
        candidate: {
          name: application.candidate.name,
          email: application.candidate.email,
          phone: application.candidate.phone,
          resumeUrl: (application.resumeUrl || application.candidate.resumeUrl) ? `/api/candidates/${application.id}/resume` : null,
          resumeFileName: application.resumeFileName || application.candidate.resumeFileName,
        },
        job: {
          title: application.job.title,
          passThreshold: application.job.passThreshold,
        },
        status: application.status,
        token: application.token,
        legalHold: application.legalHold,
        legalHoldReason: application.legalHoldReason,
        consentRecorded: application.consentRecorded,
        consentVersion: application.consentVersion,
        consentRecordedAt: application.consentRecordedAt,
        resumeMatch: await (async () => {
          let jobSkills: string[] = [];
          try {
            jobSkills = JSON.parse(application.job.skillsRequired || '[]');
          } catch {
            jobSkills = ['Git', 'Linux', 'Docker', 'Kubernetes', 'CI/CD'];
          }

          let matchedSkills: string[] = [];
          let candidateSkills: string[] = [];
          let matchScore = application.resumeMatchScore;
          let experienceYears: number | null = null;

          if (application.resumeParsedSkills) {
            try { matchedSkills = JSON.parse(application.resumeParsedSkills); } catch {}
          }

          // If resume file exists on disk, deeply parse for full extracted details
          const resumePath = application.resumeUrl || application.candidate.resumeUrl;
          if (resumePath) {
            const fullPath = path.join(process.cwd(), resumePath.replace(/^\//, ''));
            if (fs.existsSync(fullPath)) {
              try {
                const evalRes = await ResumeMatchingService.parseAndEvaluateResumeFile(
                  fullPath,
                  jobSkills,
                  application.candidate.name
                );
                matchScore = evalRes.matchScore;
                matchedSkills = evalRes.matchedSkills;
                candidateSkills = evalRes.candidateSkills;
                experienceYears = evalRes.experienceYears ?? null;

                if (application.resumeMatchScore !== evalRes.matchScore) {
                  await prisma.jobApplication.update({
                    where: { id: application.id },
                    data: {
                      resumeMatchScore: evalRes.matchScore,
                      resumeParsedSkills: JSON.stringify(evalRes.matchedSkills),
                    }
                  });
                }
              } catch {}
            }
          }

          if (matchScore === null || matchScore === undefined) {
            const candidateResumeText = application.resumeParsedText || '';
            const evalRes = ResumeMatchingService.evaluateResumeMatch(
              candidateResumeText,
              jobSkills
            );
            matchScore = evalRes.matchScore;
            matchedSkills = evalRes.matchedSkills;
            candidateSkills = evalRes.candidateSkills;
          }

          const missingSkills = jobSkills.filter(js => !matchedSkills.some(ms => ms.toLowerCase() === js.toLowerCase()));
          const riskScore = latestAttempt?.proctoringRiskScore ?? (latestAttempt ? Math.max(0, 100 - latestAttempt.integrityScore) : 0);
          const techScore = result ? Math.round(result.percentage) : null;
          const rank = ResumeMatchingService.calculateCandidateRanking({
            technicalScore: techScore,
            resumeMatchScore: matchScore ?? 0,
            proctoringRiskScore: riskScore,
            passThreshold: application.job.passThreshold,
            currentStatus: application.status,
          });

          return {
            matchScore: matchScore ?? 0,
            matchedSkills,
            missingSkills,
            candidateSkills,
            experienceYears,
            rankingScore: application.rankingScore ?? rank.rankingScore,
            recommendation: application.recommendation ?? rank.recommendation,
            recommendationLabel: rank.recommendationLabel,
          };
        })(),
        proctorLogs: latestAttempt ? latestAttempt.proctoringLogs : [],
        assessmentSummary: latestAttempt ? {
          attemptId: latestAttempt.id,
          startedAt: latestAttempt.startedAt,
          submittedAt: latestAttempt.submittedAt,
          durationMinutes: latestAttempt.submittedAt
            ? Math.round((new Date(latestAttempt.submittedAt).getTime() - new Date(latestAttempt.startedAt).getTime()) / 60000)
            : null,
          totalScore: result?.totalScore ?? null,
          score: result?.totalScore ?? null,
          maxScore: result?.maxScore ?? null,
          totalPossible: result?.maxScore ?? null,
          percentage: result?.percentage ?? null,
          scorePercentage: result?.percentage ?? null,
          integrityScore: latestAttempt.integrityScore,
          proctoringRiskScore: latestAttempt.proctoringRiskScore ?? Math.max(0, 100 - latestAttempt.integrityScore),
          tabSwitchCount: latestAttempt.tabSwitchCount,
          fullscreenViolationCount: latestAttempt.fullscreenViolationCount,
          screenShareStopCount: latestAttempt.screenShareStopCount,
          cameraDisconnectCount: latestAttempt.cameraDisconnectCount,
          isPassed: result?.isPassed ?? null,
          passed: result?.isPassed ?? null,
          riskLevel: latestAttempt.proctoringRiskLevel || (latestAttempt.integrityScore < 60 ? 'HIGH' : latestAttempt.integrityScore < 85 ? 'MEDIUM' : 'LOW'),
          sectionScores,
          sectionResults: Object.entries(sectionScores).map(([title, val]: [string, any]) => ({
            title,
            correct: val.score,
            total: val.max,
            percentage: Math.round(((val.score || 0) / (val.max || 1)) * 100),
          })),
          proctoringLogs: latestAttempt.proctoringLogs,
          proctorLogs: latestAttempt.proctoringLogs,
          codeSubmissions,
        } : null,
        timeline,
      }
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Register Candidate & Apply for Job (with Resume Upload)
 */
candidatesRouter.post('/apply', handleResumeUpload, async (req, res) => {
  const { name, email, phone, jobId } = req.body;
  const file = req.file;

  try {
    if (!name || !email || !jobId) {
      if (file) await fs.promises.unlink(file.path).catch(() => {});
      return res.status(400).json({ success: false, error: 'Name, email, and jobId are required.' });
    }

    const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const normalizedEmail = String(email).trim().toLowerCase();
    if (!EMAIL_REGEX.test(normalizedEmail)) {
      if (file) await fs.promises.unlink(file.path).catch(() => {});
      return res.status(400).json({ success: false, error: 'Invalid email address format.' });
    }

    const trimmedName = String(name).trim();
    if (trimmedName.length < 2) {
      if (file) await fs.promises.unlink(file.path).catch(() => {});
      return res.status(400).json({ success: false, error: 'Candidate name must be at least 2 characters long.' });
    }

    let parsedResumeText = '';
    if (file) {
      try {
        const buffer = await fs.promises.readFile(file.path);
        storageService.validateFileContent(buffer, file.originalname);
        parsedResumeText = await ResumeMatchingService.extractTextFromPdfBuffer(buffer);
      } catch (validationErr: any) {
        await fs.promises.unlink(file.path).catch(() => {});
        return res.status(400).json({ success: false, error: validationErr.message });
      }
    }

    const job = await prisma.job.findUnique({ where: { id: jobId } });
    if (!job) {
      if (file) await fs.promises.unlink(file.path).catch(() => {});
      return res.status(404).json({ success: false, error: 'Job not found' });
    }

    // Partition resume into tenant-specific directory
    let resumeUrl = file ? `/uploads/resumes/${file.filename}` : null;
    if (file && job.companyId) {
      const tenantDir = path.join(baseUploadsDir, 'tenants', job.companyId, 'resumes');
      if (!fs.existsSync(tenantDir)) {
        await fs.promises.mkdir(tenantDir, { recursive: true });
      }
      const tenantFilePath = path.join(tenantDir, file.filename);
      await fs.promises.rename(file.path, tenantFilePath);
      resumeUrl = `/uploads/tenants/${job.companyId}/resumes/${file.filename}`;
    }

    let candidate = await prisma.candidate.findUnique({ where: { email: normalizedEmail } });

    if (!candidate) {
      candidate = await prisma.candidate.create({
        data: {
          name,
          email,
          phone: phone || null,
          resumeUrl,
          resumeFileName: file ? file.originalname : null,
        }
      });
    }

    // Generate 256-bit cryptographically secure assessment token
    const token = `cand-${crypto.randomBytes(32).toString('hex')}`;
    const tokenExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    // Initial skill matching on parsed text if job has required skills
    let initialMatchScore: number | null = null;
    let initialMatchedSkills: string[] = [];
    if (parsedResumeText && job.skillsRequired) {
      try {
        const requiredSkills = JSON.parse(job.skillsRequired);
        const evalMatch = ResumeMatchingService.evaluateResumeMatch(parsedResumeText, requiredSkills);
        initialMatchScore = evalMatch.matchScore;
        initialMatchedSkills = evalMatch.matchedSkills;
      } catch {}
    }

    const application = await prisma.jobApplication.create({
      data: {
        candidateId: candidate.id,
        jobId: job.id,
        status: 'INVITED',
        token,
        tokenExpiresAt,
        resumeUrl,
        resumeFileName: file ? file.originalname : null,
        resumeParsedText: parsedResumeText || null,
        resumeMatchScore: initialMatchScore,
        resumeParsedSkills: initialMatchedSkills.length > 0 ? JSON.stringify(initialMatchedSkills) : null,
      }
    });

    const protocol = req.protocol;
    const host = req.get('host') || 'localhost:3000';
    const baseUrl = `${protocol}://${host.replace(':5000', ':3000')}`;

    // Send invitation email
    await EmailService.sendInvitation(candidate.name, candidate.email, job.title, token, baseUrl);

    // Dispatch in-app notification
    await NotificationService.createNotification({
      type: 'INVITATION_SENT',
      title: 'Assessment Invitation Dispatched',
      message: `Invitation sent to ${candidate.name} (${candidate.email}) for ${job.title}`,
      candidateName: candidate.name,
      candidateId: candidate.id,
      jobTitle: job.title,
      link: `/assessment/${token}`,
    });

    res.json({
      success: true,
      message: 'Application received and assessment invitation generated!',
      applicationId: application.id,
      token,
      testUrl: `${baseUrl}/assessment/${token}`
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Recruiter Action: Bulk CSV Candidate Invitation Dispatcher
 */
candidatesRouter.post('/bulk-invite', authenticateToken, requireRole(['RECRUITER', 'HR_ADMIN', 'ADMIN']), async (req: AuthenticatedRequest, res) => {
  const { jobId, candidates } = req.body;

  if (!jobId || !Array.isArray(candidates) || candidates.length === 0) {
    return res.status(400).json({ success: false, error: 'jobId and candidate array are required.' });
  }

  try {
    const job = await prisma.job.findUnique({ where: { id: jobId } });
    if (!job) return res.status(404).json({ success: false, error: 'Job opening not found' });

    const isSuperAdmin = req.user?.role === 'ADMIN' && !req.user?.companyId;
    if (!isSuperAdmin && req.user?.companyId && job.companyId !== req.user.companyId) {
      return res.status(403).json({ success: false, error: 'Forbidden: You do not own this job opening.' });
    }

    const host = req.get('host') || 'localhost:3000';
    const baseUrl = `http://${host.replace(':5000', ':3000')}`;
    const invitedList = [];

    for (const item of candidates) {
      if (!item.email || !item.name) continue;

      let cand = await prisma.candidate.findUnique({ where: { email: item.email } });
      if (!cand) {
        cand = await prisma.candidate.create({
          data: {
            name: item.name,
            email: item.email,
            phone: item.phone || null,
          }
        });
      }

      const token = `cand-${crypto.randomBytes(16).toString('hex')}`;
      const tokenExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      const app = await prisma.jobApplication.create({
        data: {
          candidateId: cand.id,
          jobId: job.id,
          status: 'INVITED',
          token,
          tokenExpiresAt,
        }
      });

      await EmailService.sendInvitation(cand.name, cand.email, job.title, token, baseUrl);
      invitedList.push({ name: cand.name, email: cand.email, token });
    }

    await prisma.auditLog.create({
      data: {
        action: 'BULK_INVITATION_SENT',
        entity: 'JobApplication',
        details: `Dispatched bulk assessment invites to ${invitedList.length} candidates for job ${job.title}.`,
      }
    });

    res.json({
      success: true,
      message: `Successfully sent ${invitedList.length} candidate assessment invitations!`,
      invitedCount: invitedList.length,
      invitedList,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Recruiter Action: Export Candidates Roster as CSV File (Scoped)
 */
candidatesRouter.get('/export-csv', authenticateToken, requireRole(['RECRUITER', 'HR_ADMIN', 'ADMIN']), async (req: AuthenticatedRequest, res) => {
  try {
    const isSuperAdmin = req.user?.role === 'ADMIN' && !req.user?.companyId;
    const whereClause = isSuperAdmin ? {} : { job: { companyId: req.user?.companyId || undefined } };

    const applications = await prisma.jobApplication.findMany({
      where: whereClause,
      include: {
        candidate: true,
        job: true,
        attempts: {
          orderBy: { startedAt: 'desc' },
          take: 1,
          include: { result: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    let csvContent = 'Application ID,Candidate Name,Email,Phone,Job Title,Status,Score (%),Integrity Score (%),Result,Invited Date\n';

    for (const app of applications) {
      const latestAttempt = app.attempts[0];
      const result = latestAttempt?.result;

      const row = [
        `"${app.id}"`,
        `"${app.candidate.name}"`,
        `"${app.candidate.email}"`,
        `"${app.candidate.phone || 'N/A'}"`,
        `"${app.job.title}"`,
        `"${app.status}"`,
        `"${result ? result.percentage : 'N/A'}"`,
        `"${latestAttempt ? latestAttempt.integrityScore : '100'}"`,
        `"${result ? (result.isPassed ? 'PASSED' : 'FAILED') : 'PENDING'}"`,
        `"${app.createdAt.toISOString()}"`,
      ].join(',');

      csvContent += row + '\n';
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="techscreen_candidates_report.csv"');
    res.send(csvContent);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Recruiter Action: Update Application Status (SHORTLISTED, HR_INTERVIEW, REJECTED, etc.)
 */
candidatesRouter.patch('/:applicationId/status', authenticateToken, requireRole(['RECRUITER', 'HR_ADMIN', 'ADMIN']), async (req: AuthenticatedRequest, res) => {
  const { applicationId } = req.params;
  const { status } = req.body;

  try {
    const existingApp = await prisma.jobApplication.findUnique({
      where: { id: applicationId },
      include: { job: true }
    });
    if (!existingApp) {
      return res.status(404).json({ success: false, error: 'Application not found' });
    }

    const isSuperAdmin = req.user?.role === 'ADMIN' && !req.user?.companyId;
    if (!isSuperAdmin && req.user?.companyId && existingApp.job.companyId !== req.user.companyId) {
      return res.status(403).json({ success: false, error: 'Forbidden: You do not own this application.' });
    }

    const application = await prisma.jobApplication.update({
      where: { id: applicationId },
      data: { status },
      include: { candidate: true, job: true }
    });

    await prisma.auditLog.create({
      data: {
        action: 'CANDIDATE_STATUS_UPDATED',
        entity: 'JobApplication',
        details: `Updated candidate ${application.candidate.name} status to ${status} for job ${application.job.title}.`,
      }
    });

    // If candidate status is updated to REJECTED, dispatch polite rejection email
    if (status === 'REJECTED') {
      await EmailService.sendRejectionEmail(
        application.candidate.name,
        application.candidate.email,
        application.job.title
      );
      await NotificationService.createNotification({
        type: 'TEST_FAILED',
        title: 'Candidate Application Rejected',
        message: `${application.candidate.name} was rejected for ${application.job.title}. Polite notification email sent.`,
        candidateName: application.candidate.name,
        candidateId: application.candidate.id,
        jobTitle: application.job.title,
      });
    } else if (status === 'SHORTLISTED') {
      await NotificationService.createNotification({
        type: 'TEST_PASSED',
        title: 'Candidate Shortlisted',
        message: `${application.candidate.name} has been shortlisted for ${application.job.title}.`,
        candidateName: application.candidate.name,
        candidateId: application.candidate.id,
        jobTitle: application.job.title,
      });
    } else if (status === 'HR_INTERVIEW') {
      await NotificationService.createNotification({
        type: 'INTERVIEW_SCHEDULED',
        title: 'Moved to HR Interview',
        message: `${application.candidate.name} advanced to HR Interview for ${application.job.title}.`,
        candidateName: application.candidate.name,
        candidateId: application.candidate.id,
        jobTitle: application.job.title,
      });
    }

    res.json({ success: true, application });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Resend Invitation Email to Candidate
 */
candidatesRouter.post('/:applicationId/resend-invite', authenticateToken, requireRole(['RECRUITER', 'HR_ADMIN', 'ADMIN']), async (req: AuthenticatedRequest, res) => {
  const { applicationId } = req.params;

  try {
    const application = await prisma.jobApplication.findUnique({
      where: { id: applicationId },
      include: { candidate: true, job: true }
    });

    if (!application) return res.status(404).json({ success: false, error: 'Application not found' });

    const isSuperAdmin = req.user?.role === 'ADMIN' && !req.user?.companyId;
    if (!isSuperAdmin && req.user?.companyId && application.job.companyId !== req.user.companyId) {
      return res.status(403).json({ success: false, error: 'Forbidden: You do not own this application.' });
    }

    const host = req.get('host') || 'localhost:3000';
    const baseUrl = `http://${host.replace(':5000', ':3000')}`;

    await EmailService.sendInvitation(
      application.candidate.name,
      application.candidate.email,
      application.job.title,
      application.token,
      baseUrl
    );

    res.json({ success: true, message: `Invitation email resent to ${application.candidate.email}` });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Recruiter Action: Re-parse uploaded PDF resume and re-evaluate skill match
 */
candidatesRouter.post('/:applicationId/reparse-resume', authenticateToken, requireRole(['RECRUITER', 'HR_ADMIN', 'ADMIN']), async (req: AuthenticatedRequest, res) => {
  const { applicationId } = req.params;

  try {
    const application = await prisma.jobApplication.findUnique({
      where: { id: applicationId },
      include: {
        candidate: true,
        job: true,
        attempts: {
          include: { result: true },
          orderBy: { startedAt: 'desc' },
          take: 1,
        }
      }
    });

    if (!application) return res.status(404).json({ success: false, error: 'Application not found' });

    const isSuperAdmin = req.user?.role === 'ADMIN' && !req.user?.companyId;
    if (!isSuperAdmin && req.user?.companyId && application.job.companyId !== req.user.companyId) {
      return res.status(403).json({ success: false, error: 'Forbidden: You do not own this application.' });
    }

    const resumePath = application.resumeUrl || application.candidate.resumeUrl;
    if (!resumePath) {
      return res.status(400).json({ success: false, error: 'Candidate has no uploaded resume file.' });
    }

    let jobSkills: string[] = [];
    try {
      jobSkills = JSON.parse(application.job.skillsRequired || '[]');
    } catch {
      jobSkills = ['Git', 'Linux', 'Docker', 'Kubernetes', 'CI/CD'];
    }

    const fullPath = storageService.resolveLocalPath(resumePath);
    const evalRes = await ResumeMatchingService.parseAndEvaluateResumeFile(
      fullPath,
      jobSkills,
      application.candidate.name
    );

    const latestAttempt = application.attempts[0];
    const techScore = latestAttempt?.result ? Math.round(latestAttempt.result.percentage) : null;
    const riskScore = latestAttempt?.proctoringRiskScore ?? (latestAttempt ? Math.max(0, 100 - latestAttempt.integrityScore) : 0);

    const ranking = ResumeMatchingService.calculateCandidateRanking({
      technicalScore: techScore,
      resumeMatchScore: evalRes.matchScore,
      proctoringRiskScore: riskScore,
      passThreshold: application.job.passThreshold,
      currentStatus: application.status,
    });

    const updated = await prisma.jobApplication.update({
      where: { id: applicationId },
      data: {
        resumeMatchScore: evalRes.matchScore,
        resumeParsedSkills: JSON.stringify(evalRes.matchedSkills),
        rankingScore: ranking.rankingScore,
        recommendation: ranking.recommendation,
      },
      include: { candidate: true, job: true }
    });

    res.json({
      success: true,
      message: `Resume parsed successfully! Match score: ${evalRes.matchScore}%`,
      matchScore: evalRes.matchScore,
      matchedSkills: evalRes.matchedSkills,
      missingSkills: evalRes.missingSkills,
      allExtractedSkills: evalRes.candidateSkills,
      experienceYears: evalRes.experienceYears,
      rankingScore: ranking.rankingScore,
      recommendation: ranking.recommendation,
      recommendationLabel: ranking.recommendationLabel,
      application: updated,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Get Team Recruiter Notes for Application
 */
candidatesRouter.get('/:applicationId/notes', authenticateToken, requireRole(['RECRUITER', 'HR_ADMIN', 'ADMIN', 'TECH_INTERVIEWER']), async (req: AuthenticatedRequest, res) => {
  const { applicationId } = req.params;

  try {
    const app = await prisma.jobApplication.findUnique({
      where: { id: applicationId },
      include: { job: true }
    });
    if (!app) return res.status(404).json({ success: false, error: 'Application not found' });

    const isSuperAdmin = req.user?.role === 'ADMIN' && !req.user?.companyId;
    if (!isSuperAdmin && req.user?.companyId && app.job.companyId !== req.user.companyId) {
      return res.status(403).json({ success: false, error: 'Forbidden: You do not own this application.' });
    }

    const notes = await prisma.recruiterNote.findMany({
      where: { applicationId },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ success: true, notes });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Add Recruiter Team Note & Star Rating
 */
candidatesRouter.post('/:applicationId/notes', authenticateToken, requireRole(['RECRUITER', 'HR_ADMIN', 'ADMIN', 'TECH_INTERVIEWER']), async (req: AuthenticatedRequest, res) => {
  const { applicationId } = req.params;
  const { authorName, rating, comment } = req.body;

  try {
    if (!comment || !comment.trim()) {
      return res.status(400).json({ success: false, error: 'Note comment is required' });
    }

    const app = await prisma.jobApplication.findUnique({
      where: { id: applicationId },
      include: { job: true }
    });
    if (!app) return res.status(404).json({ success: false, error: 'Application not found' });

    const isSuperAdmin = req.user?.role === 'ADMIN' && !req.user?.companyId;
    if (!isSuperAdmin && req.user?.companyId && app.job.companyId !== req.user.companyId) {
      return res.status(403).json({ success: false, error: 'Forbidden: You do not own this application.' });
    }

    const note = await prisma.recruiterNote.create({
      data: {
        applicationId,
        authorName: authorName || req.user?.name || 'Hiring Recruiter',
        rating: rating || 5,
        comment,
      }
    });

    res.json({ success: true, note });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Recruiter Action: Reset Assessment Attempt (Allow Candidate Retake)
 */
candidatesRouter.post('/:applicationId/reset-attempt', authenticateToken, requireRole(['RECRUITER', 'HR_ADMIN', 'ADMIN']), async (req: AuthenticatedRequest, res) => {
  const { applicationId } = req.params;

  try {
    const application = await prisma.jobApplication.findUnique({
      where: { id: applicationId },
      include: { candidate: true, job: true }
    });

    if (!application) return res.status(404).json({ success: false, error: 'Application not found' });

    const isSuperAdmin = req.user?.role === 'ADMIN' && !req.user?.companyId;
    if (!isSuperAdmin && req.user?.companyId && application.job.companyId !== req.user.companyId) {
      return res.status(403).json({ success: false, error: 'Forbidden: You do not own this application.' });
    }

    // Generate new token & extend expiration
    const newToken = `cand-${crypto.randomBytes(16).toString('hex')}`;
    const newExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await prisma.jobApplication.update({
      where: { id: applicationId },
      data: {
        status: 'INVITED',
        token: newToken,
        tokenExpiresAt: newExpiresAt,
      }
    });

    await prisma.auditLog.create({
      data: {
        userId: req.user?.id,
        userName: req.user?.name,
        action: 'ASSESSMENT_RETEST_GRANTED',
        entity: 'JobApplication',
        details: `Granted retake permission to candidate ${application.candidate.name} for job ${application.job.title}.`,
      }
    });

    const host = req.get('host') || 'localhost:3000';
    const baseUrl = `http://${host.replace(':5000', ':3000')}`;

    await EmailService.sendInvitation(
      application.candidate.name,
      application.candidate.email,
      application.job.title,
      newToken,
      baseUrl
    );

    res.json({ success: true, message: `Assessment reset successfully. Retake link dispatched to ${application.candidate.email}` });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Recruiter Action: Schedule HR Interview & Send Invitation
 */
candidatesRouter.post('/:applicationId/schedule-interview', authenticateToken, requireRole(['RECRUITER', 'HR_ADMIN', 'ADMIN']), async (req: AuthenticatedRequest, res) => {
  const { applicationId } = req.params;
  const { interviewScheduledAt, interviewLink } = req.body;

  try {
    if (!interviewScheduledAt) {
      return res.status(400).json({ success: false, error: 'interviewScheduledAt date is required' });
    }

    const existingApp = await prisma.jobApplication.findUnique({
      where: { id: applicationId },
      include: { job: true }
    });
    if (!existingApp) return res.status(404).json({ success: false, error: 'Application not found' });

    const isSuperAdmin = req.user?.role === 'ADMIN' && !req.user?.companyId;
    if (!isSuperAdmin && req.user?.companyId && existingApp.job.companyId !== req.user.companyId) {
      return res.status(403).json({ success: false, error: 'Forbidden: You do not own this application.' });
    }

    const application = await prisma.jobApplication.update({
      where: { id: applicationId },
      data: {
        status: 'HR_INTERVIEW',
        interviewScheduledAt: new Date(interviewScheduledAt),
        interviewLink: interviewLink || 'https://meet.google.com/techscreen-hr-interview',
      },
      include: { candidate: true, job: true }
    });

    const scheduledDateStr = new Date(interviewScheduledAt).toLocaleString();
    const meetingUrl = application.interviewLink || 'https://meet.google.com/techscreen-hr-interview';

    // Dispatch real email via EmailService
    await EmailService.sendInterviewInvite(
      application.candidate.name,
      application.candidate.email,
      application.job.title,
      scheduledDateStr,
      meetingUrl
    );

    await NotificationService.createNotification({
      type: 'INTERVIEW_SCHEDULED',
      title: '📅 HR Interview Scheduled',
      message: `Interview with ${application.candidate.name} scheduled for ${scheduledDateStr}`,
      candidateName: application.candidate.name,
      candidateId: application.candidate.id,
      jobTitle: application.job.title,
    });

    await prisma.auditLog.create({
      data: {
        userId: req.user?.id,
        userName: req.user?.name,
        action: 'HR_INTERVIEW_SCHEDULED',
        entity: 'JobApplication',
        details: `Scheduled HR interview for candidate ${application.candidate.name} on ${scheduledDateStr}`,
      }
    });

    res.json({ success: true, application, message: 'HR Interview scheduled and candidate notified via email.' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Authenticated Resume Streaming Endpoint (Anti-PII Leakage & Multi-Tenant Verified)
 * Requirements:
 * 1. authenticate requester (recruiter JWT or candidate assessment token)
 * 2. determine company
 * 3. verify application belongs to requester's company
 * 4. stream the file
 * 5. prevent path traversal
 * 6. never expose filesystem path
 * 7. return 401/403/404 for unauthorized access
 */
candidatesRouter.get('/:applicationId/resume', optionalAuth, async (req: AuthenticatedRequest, res) => {
  const { applicationId } = req.params;
  const tokenQuery = req.query.token as string | undefined;

  try {
    const application = await prisma.jobApplication.findUnique({
      where: { id: applicationId },
      include: {
        candidate: true,
        job: { include: { company: true } }
      }
    });

    if (!application) {
      return res.status(404).json({ success: false, error: 'Candidate application not found.' });
    }

    // Verify Authorization:
    let isAuthorized = false;
    if (req.user) {
      const isSuperAdmin = req.user.role === 'ADMIN' && !req.user.companyId;
      const isTenantUser = req.user.companyId && req.user.companyId === application.job.companyId;
      if (isSuperAdmin || isTenantUser) {
        isAuthorized = true;
      }
    }

    // Check candidate assessment token (header or query)
    const assessmentToken = tokenQuery || (req.headers['x-assessment-token'] as string);
    if (assessmentToken && assessmentToken === application.token) {
      isAuthorized = true;
    }

    if (!isAuthorized) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden: You do not have permission to access this candidate resume.'
      });
    }

    const resumeRelativePath = application.resumeUrl || application.candidate.resumeUrl;
    if (!resumeRelativePath) {
      return res.status(404).json({ success: false, error: 'No resume file associated with this application.' });
    }

    // Anti-Path Traversal & Safe Path Resolution
    const safeBaseDir = path.resolve(process.cwd(), 'uploads');
    const fullPath = path.resolve(process.cwd(), resumeRelativePath.replace(/^\//, ''));

    if (!fullPath.startsWith(safeBaseDir)) {
      return res.status(403).json({ success: false, error: 'Access denied: Directory traversal detected.' });
    }

    // Tenant boundary verification on path
    if (fullPath.includes('/tenants/')) {
      const expectedTenantDir = path.resolve(safeBaseDir, 'tenants', application.job.companyId);
      if (!fullPath.startsWith(expectedTenantDir)) {
        return res.status(403).json({ success: false, error: 'Access denied: Cross-tenant resume file access prohibited.' });
      }
    }

    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ success: false, error: 'Resume file not found on disk.' });
    }

    const fileName = application.resumeFileName || application.candidate.resumeFileName || 'resume.pdf';
    const ext = path.extname(fileName).toLowerCase();
    const mimeTypes: Record<string, string> = {
      '.pdf': 'application/pdf',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.doc': 'application/msword',
      '.txt': 'text/plain',
    };

    res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(fileName)}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');

    fs.createReadStream(fullPath).pipe(res);
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'An error occurred while streaming the file.' });
  }
});

/**
 * Authenticated Proctoring Snapshot Streaming Endpoint
 * Accessible only by Recruiter / Admin belonging to applicant's company.
 */
candidatesRouter.get('/:applicationId/snapshots/:filename', authenticateToken, requireRole(['RECRUITER', 'ADMIN', 'HR_ADMIN', 'TECH_INTERVIEWER']), async (req: AuthenticatedRequest, res) => {
  const { applicationId, filename } = req.params;

  try {
    const application = await prisma.jobApplication.findUnique({
      where: { id: applicationId },
      include: { job: true }
    });

    if (!application) {
      return res.status(404).json({ success: false, error: 'Application not found.' });
    }

    const isSuperAdmin = req.user?.role === 'ADMIN' && !req.user?.companyId;
    if (!isSuperAdmin && req.user?.companyId !== application.job.companyId) {
      return res.status(403).json({ success: false, error: 'Forbidden: You do not own this application.' });
    }

    const cleanFilename = path.basename(filename);
    const tenantBaseDir = path.resolve(baseUploadsDir, 'tenants', application.job.companyId, 'proctoring');
    const legacyBaseDir = path.resolve(baseUploadsDir, 'proctoring');

    const tenantPath = path.resolve(tenantBaseDir, cleanFilename);
    const legacyPath = path.resolve(legacyBaseDir, cleanFilename);

    let fullPath: string | null = null;
    if (fs.existsSync(tenantPath) && tenantPath.startsWith(tenantBaseDir)) {
      fullPath = tenantPath;
    } else if (fs.existsSync(legacyPath) && legacyPath.startsWith(legacyBaseDir)) {
      fullPath = legacyPath;
    }

    if (!fullPath) {
      return res.status(404).json({ success: false, error: 'Snapshot image not found.' });
    }

    const ext = path.extname(cleanFilename).toLowerCase();
    const mimeTypes: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.webp': 'image/webp',
    };

    res.setHeader('Content-Type', mimeTypes[ext] || 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    fs.createReadStream(fullPath).pipe(res);
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'Failed to stream snapshot.' });
  }
});

/**
 * DPDP Section 11: Candidate Data Subject Access Request (DSAR) Export
 * Generates a structured JSON export of all personal data held for the candidate.
 */
candidatesRouter.get('/:applicationId/export-data', authenticateToken, requireRole(['RECRUITER', 'ADMIN', 'HR_ADMIN']), async (req: AuthenticatedRequest, res) => {
  const { applicationId } = req.params;

  try {
    const application = await prisma.jobApplication.findUnique({
      where: { id: applicationId },
      include: {
        candidate: true,
        job: { include: { company: true } },
        attempts: {
          include: {
            result: true,
            answers: true,
            proctoringLogs: {
              select: {
                id: true,
                eventType: true,
                timestamp: true,
                details: true,
              },
            },
          },
        },
      },
    });

    if (!application) {
      return res.status(404).json({ success: false, error: 'Application record not found.' });
    }

    const isSuperAdmin = req.user?.role === 'ADMIN' && !req.user?.companyId;
    if (!isSuperAdmin && req.user?.companyId !== application.job.companyId) {
      return res.status(403).json({ success: false, error: 'Forbidden: Access denied across tenant boundary.' });
    }

    const dsarExport = {
      complianceFramework: 'Digital Personal Data Protection Act, 2023 (Section 11 Access Request)',
      exportedAt: new Date(),
      dataPrincipal: {
        candidateId: application.candidate.id,
        name: application.candidate.name,
        email: application.candidate.email,
        phone: application.candidate.phone,
        appliedAt: application.createdAt,
      },
      dataFiduciary: {
        companyId: application.job.company.id,
        companyName: application.job.company.name,
        jobTitle: application.job.title,
      },
      consentAudit: {
        consentRecorded: application.consentRecorded,
        consentVersion: application.consentVersion,
        consentRecordedAt: application.consentRecordedAt,
      },
      legalStatus: {
        applicationStatus: application.status,
        legalHold: application.legalHold,
        legalHoldReason: application.legalHoldReason,
      },
      professionalData: {
        resumeFileName: application.resumeFileName,
        resumeParsedSkills: application.resumeParsedSkills ? JSON.parse(application.resumeParsedSkills) : [],
        resumeMatchScore: application.resumeMatchScore,
      },
      evaluations: application.attempts.map(attempt => ({
        attemptId: attempt.id,
        startedAt: attempt.startedAt,
        submittedAt: attempt.submittedAt,
        integrityScore: attempt.integrityScore,
        proctoringRiskScore: attempt.proctoringRiskScore,
        proctoringRiskLevel: attempt.proctoringRiskLevel,
        totalViolationsCount: attempt.proctoringLogs.length,
        proctoringTimeline: attempt.proctoringLogs,
        result: attempt.result ? {
          percentage: attempt.result.percentage,
          isPassed: attempt.result.isPassed,
          evaluatedAt: attempt.result.evaluatedAt,
        } : null,
      })),
    };

    await prisma.auditLog.create({
      data: {
        userId: req.user?.id,
        userName: req.user?.name,
        companyId: application.job.companyId,
        action: 'DPDP_DATA_EXPORTED',
        entity: 'JobApplication',
        details: `DSAR Personal Data Export generated for application ${application.id}`,
      },
    });

    res.json({
      success: true,
      dsarExport,
      exportMetadata: {
        complianceFramework: dsarExport.complianceFramework,
        exportedAt: dsarExport.exportedAt,
      },
      candidate: dsarExport.dataPrincipal,
      consentDetails: dsarExport.consentAudit,
      proctoringTelemetry: dsarExport.evaluations,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'Failed to compile DSAR export: ' + err.message });
  }
});

/**
 * DPDP Compliance: Manage Legal Hold on Candidate Record
 * Prevents erasure when data must be retained for statutory/regulatory obligations or active disputes.
 */
candidatesRouter.patch('/:applicationId/legal-hold', authenticateToken, requireRole(['RECRUITER', 'ADMIN', 'HR_ADMIN']), async (req: AuthenticatedRequest, res) => {
  const { applicationId } = req.params;
  const { legalHold, reason } = req.body;

  if (typeof legalHold !== 'boolean') {
    return res.status(400).json({ success: false, error: 'legalHold boolean field is required.' });
  }

  try {
    const application = await prisma.jobApplication.findUnique({
      where: { id: applicationId },
      include: { job: true },
    });

    if (!application) {
      return res.status(404).json({ success: false, error: 'Application record not found.' });
    }

    const isSuperAdmin = req.user?.role === 'ADMIN' && !req.user?.companyId;
    if (!isSuperAdmin && req.user?.companyId !== application.job.companyId) {
      return res.status(403).json({ success: false, error: 'Forbidden: Access denied across tenant boundary.' });
    }

    const updated = await prisma.jobApplication.update({
      where: { id: applicationId },
      data: {
        legalHold,
        legalHoldReason: legalHold ? (reason || 'Administrative/Statutory Legal Hold') : null,
      },
    });

    await prisma.auditLog.create({
      data: {
        userId: req.user?.id,
        userName: req.user?.name,
        companyId: application.job.companyId,
        action: legalHold ? 'LEGAL_HOLD_PLACED' : 'LEGAL_HOLD_REMOVED',
        entity: 'JobApplication',
        details: `Legal hold ${legalHold ? 'activated' : 'deactivated'} for application ${application.id}: ${reason || 'N/A'}`,
      },
    });

    res.json({
      success: true,
      legalHold: updated.legalHold,
      legalHoldReason: updated.legalHoldReason,
      message: `Legal Hold ${legalHold ? 'successfully placed' : 'successfully removed'}.`,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'Failed to update legal hold: ' + err.message });
  }
});

/**
 * DPDP Section 12: Candidate Right to Erasure / Anonymization
 * Erases PII and physical media, strictly enforcing active Legal Hold check.
 */
candidatesRouter.delete('/:applicationId/personal-data', authenticateToken, requireRole(['RECRUITER', 'ADMIN', 'HR_ADMIN']), async (req: AuthenticatedRequest, res) => {
  const { applicationId } = req.params;

  try {
    const application = await prisma.jobApplication.findUnique({
      where: { id: applicationId },
      include: {
        job: true,
        candidate: true,
        attempts: true,
      },
    });

    if (!application) {
      return res.status(404).json({ success: false, error: 'Application record not found.' });
    }

    const isSuperAdmin = req.user?.role === 'ADMIN' && !req.user?.companyId;
    if (!isSuperAdmin && req.user?.companyId !== application.job.companyId) {
      return res.status(403).json({ success: false, error: 'Forbidden: Access denied across tenant boundary.' });
    }

    // MANDATORY EXCEPTION: Check for active Legal Hold
    if (application.legalHold) {
      return res.status(409).json({
        success: false,
        error: 'Cannot erase candidate personal data: Active Legal Hold is in effect for statutory compliance or ongoing dispute.',
        legalHoldReason: application.legalHoldReason,
      });
    }

    // 1. Delete physical resume file from disk
    if (application.resumeUrl) {
      const resolvedResumePath = storageService.resolveLocalPath(application.resumeUrl);
      if (fs.existsSync(resolvedResumePath)) {
        try {
          fs.unlinkSync(resolvedResumePath);
        } catch (fileErr) {
          console.warn('[DPDP ERASURE] Failed to unlink resume file:', fileErr);
        }
      }
    }

    // 2. Delete all physical webcam proctoring snapshots from disk
    const tenantProctoringDir = path.resolve(baseUploadsDir, 'tenants', application.job.companyId, 'proctoring');
    if (fs.existsSync(tenantProctoringDir)) {
      try {
        const files = fs.readdirSync(tenantProctoringDir);
        for (const f of files) {
          if (f.includes(application.id) || f.includes(application.candidateId)) {
            const filePath = path.join(tenantProctoringDir, f);
            if (fs.existsSync(filePath)) {
              fs.unlinkSync(filePath);
            }
          }
        }
      } catch (proctorErr) {
        console.warn('[DPDP ERASURE] Error cleaning proctoring snapshots:', proctorErr);
      }
    }

    // 3. Anonymize candidate PII and clear sensitive details
    const anonymizedEmail = `anonymized-${application.id.slice(0, 8)}@redacted.local`;
    await prisma.$transaction([
      prisma.candidate.update({
        where: { id: application.candidateId },
        data: {
          name: '[Anonymized Candidate]',
          email: anonymizedEmail,
          phone: null,
          resumeUrl: null,
          resumeFileName: null,
        },
      }),
      prisma.jobApplication.update({
        where: { id: application.id },
        data: {
          status: 'ANONYMIZED',
          resumeUrl: null,
          resumeFileName: null,
          resumeParsedText: null,
          resumeParsedSkills: null,
          interviewLink: null,
        },
      }),
      prisma.auditLog.create({
        data: {
          userId: req.user?.id,
          userName: req.user?.name,
          companyId: application.job.companyId,
          action: 'DPDP_DATA_ERASED',
          entity: 'JobApplication',
          details: `Candidate PII and associated media erased under DPDP Section 12 for application ${application.id}`,
        },
      }),
    ]);

    res.json({
      success: true,
      message: 'Candidate personal data and media successfully erased under DPDP Section 12.',
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'Failed to erase personal data: ' + err.message });
  }
});

/**
 * DPDP Section 6: Candidate Right to Withdraw Consent
 * Halts assessment processing and marks session as CONSENT_WITHDRAWN.
 */
candidatesRouter.post('/:applicationId/withdraw-consent', authenticateToken, requireRole(['RECRUITER', 'ADMIN', 'HR_ADMIN']), async (req: AuthenticatedRequest, res) => {
  const { applicationId } = req.params;

  try {
    const application = await prisma.jobApplication.findUnique({
      where: { id: applicationId },
      include: { job: true },
    });

    if (!application) {
      return res.status(404).json({ success: false, error: 'Application record not found.' });
    }

    const isSuperAdmin = req.user?.role === 'ADMIN' && !req.user?.companyId;
    if (!isSuperAdmin && req.user?.companyId !== application.job.companyId) {
      return res.status(403).json({ success: false, error: 'Forbidden: Access denied across tenant boundary.' });
    }

    await prisma.$transaction([
      prisma.jobApplication.update({
        where: { id: applicationId },
        data: {
          status: 'CONSENT_WITHDRAWN',
          consentRecorded: false,
          tokenExpiresAt: new Date(0), // expire token immediately
        },
      }),
      prisma.auditLog.create({
        data: {
          userId: req.user?.id,
          userName: req.user?.name,
          companyId: application.job.companyId,
          action: 'DPDP_CONSENT_WITHDRAWN',
          entity: 'JobApplication',
          details: `Consent withdrawal recorded for application ${application.id}. Assessment token invalidated.`,
        },
      }),
    ]);

    res.json({
      success: true,
      message: 'Candidate consent withdrawal recorded. Evaluation session terminated.',
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'Failed to record consent withdrawal: ' + err.message });
  }
});
