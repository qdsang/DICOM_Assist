import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

interface LandingScreenProps {
  children: ReactNode;
}

export default function LandingScreen({ children }: LandingScreenProps) {
  const { t } = useTranslation();
  return (
    <div className="min-h-screen flex items-center justify-center bg-black text-zinc-300 p-8">
      <div className="max-w-2xl w-full">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-white mb-2">DICOM Assist</h1>
          <p className="text-lg text-zinc-400">{t('landing.subtitle')}</p>
          <p className="text-sm text-zinc-500 mt-2">
            {t('landing.tagline1')}
            <br />
            {t('landing.tagline2')}
          </p>
        </div>

        {/* Drop zone (rendered by DicomDropZone) */}
        <div className="h-[22rem] mb-10">
          {children}
        </div>

        {/* How it works */}
        <div className="mb-8">
          <h3 className="text-sm font-semibold text-zinc-400 uppercase tracking-wide mb-4">
            {t('landing.howItWorks')}
          </h3>
          <div className="space-y-3 text-sm">
            <div>
              <span className="text-blue-400 font-mono mr-2">1.</span>
              <strong className="text-zinc-200">{t('landing.step1Label')}</strong>
              <span className="text-zinc-400"> — {t('landing.step1Desc')}</span>
            </div>
            <div>
              <span className="text-blue-400 font-mono mr-2">2.</span>
              <strong className="text-zinc-200">{t('landing.step2Label')}</strong>
              <span className="text-zinc-400"> — {t('landing.step2Desc')}</span>
            </div>
            <div>
              <span className="text-blue-400 font-mono mr-2">3.</span>
              <strong className="text-zinc-200">{t('landing.step3Label')}</strong>
              <span className="text-zinc-400"> — {t('landing.step3Desc')}</span>
            </div>
            <div>
              <span className="text-blue-400 font-mono mr-2">4.</span>
              <strong className="text-zinc-200">{t('landing.step4Label')}</strong>
              <span className="text-zinc-400"> — {t('landing.step4Desc')}</span>
            </div>
          </div>
        </div>

        {/* Features */}
        <div className="mb-8">
          <h3 className="text-sm font-semibold text-zinc-400 uppercase tracking-wide mb-4">
            {t('landing.features')}
          </h3>
          <ul className="text-sm text-zinc-400 space-y-1.5">
            <li>{t('landing.feature1')}</li>
            <li>{t('landing.feature2')}</li>
            <li>{t('landing.feature3')}</li>
            <li>{t('landing.feature4')}</li>
            <li>{t('landing.feature5')}</li>
          </ul>
        </div>

        {/* Footer */}
        <div className="text-center text-xs text-zinc-600 space-x-3">
          <span>{t('landing.openSource')}</span>
          <span>&middot;</span>
          <a
            href="https://github.com/qdsang/DICOM_Assist"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-zinc-400 transition-colors"
          >
            GitHub
          </a>
          <span>&middot;</span>
          <span>{t('landing.educationalOnly')}</span>
        </div>
      </div>
    </div>
  );
}
