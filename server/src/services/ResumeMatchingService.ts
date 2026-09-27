import fs from 'fs';
import path from 'path';

// Ensure DOM / Canvas globals required by pdfjs-dist / pdf-parse in headless Node / serverless environments are polyfilled
if (typeof (globalThis as any).DOMMatrix === 'undefined') {
  (globalThis as any).DOMMatrix = class DOMMatrix {
    a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
    m11 = 1; m12 = 0; m21 = 0; m22 = 1; m41 = 0; m42 = 0;
    constructor(_init?: any) {}
  };
}
if (typeof (globalThis as any).ImageData === 'undefined') {
  (globalThis as any).ImageData = class ImageData {
    data: Uint8ClampedArray;
    width: number;
    height: number;
    constructor(width: number, height: number) {
      this.width = width;
      this.height = height;
      this.data = new Uint8ClampedArray(width * height * 4);
    }
  };
}
if (typeof (globalThis as any).Path2D === 'undefined') {
  (globalThis as any).Path2D = class Path2D {};
}

export interface ResumeMatchResult {
  matchScore: number; // 0 to 100
  matchedSkills: string[];
  missingSkills: string[];
  candidateSkills: string[];
  experienceYears?: number | null;
  extractedSnippet?: string;
}

export interface CandidateRankingResult {
  rankingScore: number; // e.g. 84.5
  technicalScore: number | null;
  resumeMatchScore: number;
  proctoringRiskScore: number;
  proctoringRiskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  recommendation: 'STRONG_CANDIDATE' | 'POTENTIAL_MATCH' | 'MANUAL_REVIEW' | 'REJECT';
  recommendationLabel: string;
}

export class ResumeMatchingService {
  /**
   * Comprehensive Enterprise Tech Skill Taxonomy Dictionary (120+ skills)
   */
  private static readonly KNOWN_SKILLS = [
    // DevOps & Automation
    'git', 'github', 'gitlab', 'bitbucket', 'linux', 'ubuntu', 'centos', 'debian', 'fedora', 'rhel',
    'bash', 'shell', 'zsh', 'powershell', 'docker', 'containerd', 'podman', 'kubernetes', 'k8s',
    'helm', 'kustomize', 'terraform', 'opentofu', 'ansible', 'puppet', 'chef', 'ci/cd', 'jenkins',
    'github actions', 'gitlab ci', 'argo', 'argocd', 'circleci', 'travis ci', 'tekton', 'flux',
    // Cloud Platforms & Services
    'aws', 'amazon web services', 'azure', 'microsoft azure', 'gcp', 'google cloud', 'ec2', 's3',
    'rds', 'lambda', 'eks', 'ecs', 'fargate', 'cloudformation', 'iam', 'route53', 'cloudwatch',
    // Monitoring & Observability
    'prometheus', 'grafana', 'datadog', 'new relic', 'dynatrace', 'elk', 'elasticsearch',
    'logstash', 'kibana', 'opensearch', 'splunk', 'jaeger', 'opentelemetry',
    // Web Servers, Ingress & Networking
    'nginx', 'apache', 'caddy', 'traefik', 'envoy', 'haproxy', 'istio', 'linkerd', 'dns', 'tcp/ip', 'http/https',
    // Programming Languages & Runtimes
    'python', 'golang', 'go', 'rust', 'javascript', 'typescript', 'java', 'c++', 'c#', '.net', 'asp.net',
    'php', 'ruby', 'scala', 'kotlin', 'swift', 'perl',
    // Backend Frameworks & APIs
    'node.js', 'express', 'nest.js', 'fastapi', 'django', 'flask', 'spring boot', 'gin', 'fiber',
    'rails', 'laravel', 'graphql', 'rest api', 'grpc', 'microservices', 'system design',
    // Frontend & Web
    'react', 'next.js', 'vue', 'nuxt', 'angular', 'svelte', 'html5', 'css3', 'tailwind', 'bootstrap',
    'redux', 'zustand', 'webpack', 'vite', 'webrtc',
    // Databases & Caching
    'sql', 'postgresql', 'postgres', 'mysql', 'mariadb', 'sqlite', 'mongodb', 'redis', 'memcached',
    'dynamodb', 'cassandra', 'couchdb', 'neo4j', 'prisma', 'typeorm', 'hibernate',
    // Messaging & Queues
    'kafka', 'rabbitmq', 'sqs', 'sns', 'nats', 'celery', 'bullmq',
    // Security & Compliance
    'owasp', 'soc2', 'iso 27001', 'gdpr', 'vault', 'hashicorp vault', 'sonarqube', 'snyk', 'trivy', 'oauth', 'jwt'
  ];

  /**
   * Extract raw text layers from PDF file buffer or Uint8Array
   */
  static async extractTextFromPdfBuffer(buffer: Buffer | Uint8Array): Promise<string> {
    try {
      const { PDFParse } = await import('pdf-parse');
      const uint8 = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      const parser = new PDFParse(uint8);
      const result = await parser.getText();
      return (typeof result === 'string' ? result : (result as any).text || '').trim();
    } catch (err: any) {
      console.warn('[RESUME PARSER] Failed to parse PDF buffer:', err.message);
      return '';
    }
  }

  /**
   * Extract raw text layers from PDF stored on local disk
   */
  static async extractTextFromPdfFile(filePath: string): Promise<string> {
    try {
      if (!fs.existsSync(filePath)) {
        console.warn(`[RESUME PARSER] File does not exist at: ${filePath}`);
        return '';
      }
      const buffer = fs.readFileSync(filePath);
      return await this.extractTextFromPdfBuffer(buffer);
    } catch (err: any) {
      console.warn(`[RESUME PARSER] Error reading file ${filePath}:`, err.message);
      return '';
    }
  }

  /**
   * Extract estimated years of professional experience using regex heuristics
   */
  static extractExperienceYears(content: string): number | null {
    if (!content) return null;
    const lower = content.toLowerCase();

    // Look for patterns like "5+ years of experience", "3 years in devops", "4 yrs experience"
    const patterns = [
      /(\d+)\+?\s*(?:years?|yrs?)\s+(?:of\s+)?experience/i,
      /experience\s*:\s*(\d+)\+?\s*(?:years?|yrs?)/i,
      /(?:for|with)\s+(\d+)\+?\s*(?:years?|yrs?)/i,
      /(\d+)\+?\s*(?:years?|yrs?)\s+in\s+[a-z0-9_\s]+/i,
      /(\d+)\+?\s*(?:years?|yrs?)\s+working/i,
    ];

    for (const pattern of patterns) {
      const match = lower.match(pattern);
      if (match && match[1]) {
        const years = parseInt(match[1], 10);
        if (years >= 0 && years <= 40) {
          return years;
        }
      }
    }

    return null;
  }

  /**
   * Parse skills from resume text, file name, or existing skills list
   */
  static extractSkillsFromContent(content: string): string[] {
    const lower = (content || '').toLowerCase();
    const found = new Set<string>();

    for (const skill of this.KNOWN_SKILLS) {
      // Regex word boundary matching or slash match (e.g. CI/CD)
      const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`(^|[^a-zA-Z0-9_#+])${escaped}([^a-zA-Z0-9_#+]|$)`, 'i');
      if (regex.test(lower)) {
        // Standardize skill display name
        found.add(this.standardizeSkillName(skill));
      }
    }

    return Array.from(found);
  }

  /**
   * Clean skill name normalization
   */
  private static standardizeSkillName(raw: string): string {
    const map: Record<string, string> = {
      git: 'Git',
      github: 'GitHub',
      'github actions': 'GitHub Actions',
      gitlab: 'GitLab',
      'gitlab ci': 'GitLab CI',
      linux: 'Linux',
      ubuntu: 'Ubuntu',
      debian: 'Debian',
      rhel: 'RHEL',
      fedora: 'Fedora',
      centos: 'CentOS',
      bash: 'Bash',
      shell: 'Shell Scripting',
      docker: 'Docker',
      kubernetes: 'Kubernetes',
      k8s: 'Kubernetes',
      helm: 'Helm',
      aws: 'AWS',
      'amazon web services': 'AWS',
      azure: 'Azure',
      'microsoft azure': 'Azure',
      gcp: 'GCP',
      'google cloud': 'GCP',
      terraform: 'Terraform',
      ansible: 'Ansible',
      'ci/cd': 'CI/CD',
      jenkins: 'Jenkins',
      argocd: 'ArgoCD',
      argo: 'ArgoCD',
      python: 'Python',
      golang: 'Go',
      go: 'Go',
      rust: 'Rust',
      javascript: 'JavaScript',
      typescript: 'TypeScript',
      react: 'React',
      'next.js': 'Next.js',
      'node.js': 'Node.js',
      express: 'Express.js',
      'nest.js': 'Nest.js',
      'c#': 'C#',
      '.net': '.NET',
      'asp.net': 'ASP.NET',
      sql: 'SQL',
      postgresql: 'PostgreSQL',
      postgres: 'PostgreSQL',
      mysql: 'MySQL',
      mongodb: 'MongoDB',
      redis: 'Redis',
      tailwind: 'Tailwind CSS',
      devops: 'DevOps',
      prometheus: 'Prometheus',
      grafana: 'Grafana',
      datadog: 'Datadog',
      nginx: 'Nginx',
      kafka: 'Kafka',
      rabbitmq: 'RabbitMQ',
      graphql: 'GraphQL',
      'rest api': 'REST APIs',
      microservices: 'Microservices',
      'system design': 'System Design',
      elasticsearch: 'Elasticsearch',
      sonarqube: 'SonarQube',
      vault: 'HashiCorp Vault',
    };
    return map[raw.toLowerCase()] || raw.charAt(0).toUpperCase() + raw.slice(1);
  }

  /**
   * Calculate match score between candidate profile and job requirements
   */
  static evaluateResumeMatch(
    candidateResumeTextOrMeta: string,
    jobSkillsRequired: string[],
    fallbackCandidateSkills?: string[]
  ): ResumeMatchResult {
    // 1. Extract candidate skills from textual body
    const extracted = this.extractSkillsFromContent(candidateResumeTextOrMeta);
    if (fallbackCandidateSkills && fallbackCandidateSkills.length > 0) {
      for (const s of fallbackCandidateSkills) {
        extracted.push(this.standardizeSkillName(s));
      }
    }

    const candidateSkillSet = new Set(extracted.map(s => s.toLowerCase()));

    // 2. Compare against required skills
    const matched: string[] = [];
    const missing: string[] = [];

    for (const reqSkill of jobSkillsRequired) {
      const lowerReq = reqSkill.toLowerCase();
      // Match direct or synonym (e.g. k8s -> kubernetes, postgres -> postgresql)
      let isMatch = candidateSkillSet.has(lowerReq);
      if (!isMatch) {
        for (const candSkill of candidateSkillSet) {
          if (candSkill.includes(lowerReq) || lowerReq.includes(candSkill)) {
            isMatch = true;
            break;
          }
        }
      }

      if (isMatch) {
        matched.push(reqSkill);
      } else {
        missing.push(reqSkill);
      }
    }

    const totalReq = jobSkillsRequired.length || 1;
    const matchScore = Math.min(100, Math.round((matched.length / totalReq) * 100));
    const experienceYears = this.extractExperienceYears(candidateResumeTextOrMeta);

    return {
      matchScore,
      matchedSkills: matched,
      missingSkills: missing,
      candidateSkills: Array.from(new Set(extracted)),
      experienceYears,
      extractedSnippet: candidateResumeTextOrMeta.slice(0, 300),
    };
  }

  /**
   * Deeply parse an uploaded resume PDF from filesystem and evaluate against job skills
   */
  static async parseAndEvaluateResumeFile(
    relativeOrAbsolutePath: string,
    jobSkillsRequired: string[],
    candidateName?: string
  ): Promise<ResumeMatchResult> {
    let fullPath = relativeOrAbsolutePath;
    if (!path.isAbsolute(fullPath)) {
      fullPath = path.join(process.cwd(), relativeOrAbsolutePath.replace(/^\//, ''));
    }

    let extractedText = '';
    if (fs.existsSync(fullPath) && fullPath.toLowerCase().endsWith('.pdf')) {
      extractedText = await this.extractTextFromPdfFile(fullPath);
    }

    // Combine extracted text with candidate metadata for robust matching
    const combinedContent = `${candidateName || ''} ${path.basename(fullPath)} ${extractedText}`.trim();

    return this.evaluateResumeMatch(combinedContent, jobSkillsRequired);
  }

  /**
   * Calculate Transparent Composite Candidate Ranking Score
   * Formula:
   * Final Score = (Technical Score * 0.60) + (Resume Match * 0.30) - (Proctor Risk * 0.10)
   */
  static calculateCandidateRanking(params: {
    technicalScore: number | null;
    resumeMatchScore: number;
    proctoringRiskScore: number;
    passThreshold?: number;
    currentStatus?: string;
  }): CandidateRankingResult {
    const { technicalScore, resumeMatchScore, proctoringRiskScore, passThreshold = 70, currentStatus } = params;

    // Determine Risk Level
    let proctoringRiskLevel: 'LOW' | 'MEDIUM' | 'HIGH' = 'LOW';
    if (proctoringRiskScore >= 61) {
      proctoringRiskLevel = 'HIGH';
    } else if (proctoringRiskScore >= 31) {
      proctoringRiskLevel = 'MEDIUM';
    }

    // Weighted calculation
    const weightedTech = (technicalScore !== null ? technicalScore : resumeMatchScore) * 0.60;
    const weightedResume = (resumeMatchScore || 0) * 0.30;
    const riskDeduction = Math.min(proctoringRiskScore || 0, 100) * 0.10;

    const rankingScore = Math.max(0, Math.min(100, Math.round((weightedTech + weightedResume - riskDeduction) * 10) / 10));

    // Determine Recommendation
    let recommendation: 'STRONG_CANDIDATE' | 'POTENTIAL_MATCH' | 'MANUAL_REVIEW' | 'REJECT' = 'POTENTIAL_MATCH';
    let recommendationLabel = 'Potential Match';

    if (currentStatus === 'REJECTED' || (technicalScore !== null && technicalScore < passThreshold)) {
      recommendation = 'REJECT';
      recommendationLabel = 'Reject Application';
    } else if (proctoringRiskLevel === 'HIGH' || currentStatus === 'MANUAL_REVIEW') {
      recommendation = 'MANUAL_REVIEW';
      recommendationLabel = 'Manual Proctoring Review';
    } else if (technicalScore !== null && technicalScore >= passThreshold && rankingScore >= 75) {
      recommendation = 'STRONG_CANDIDATE';
      recommendationLabel = 'Strong Candidate';
    } else if (technicalScore !== null && technicalScore >= passThreshold) {
      recommendation = 'POTENTIAL_MATCH';
      recommendationLabel = 'Potential Match';
    } else if (technicalScore === null && resumeMatchScore >= 70) {
      recommendation = 'POTENTIAL_MATCH';
      recommendationLabel = 'Potential Match (Pending Assessment)';
    }

    return {
      rankingScore,
      technicalScore,
      resumeMatchScore,
      proctoringRiskScore,
      proctoringRiskLevel,
      recommendation,
      recommendationLabel,
    };
  }
}
