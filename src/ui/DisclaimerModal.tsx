import { useTranslation } from 'react-i18next';

interface DisclaimerModalProps {
  onAccept: () => void;
}

export default function DisclaimerModal({ onAccept }: DisclaimerModalProps) {
  const { t } = useTranslation();
  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
      <div className="bg-zinc-900 border border-zinc-700 rounded-lg max-w-lg w-full p-6">
        <h2 className="text-xl font-semibold text-white mb-4 text-center">
          {t('disclaimer.title')}
        </h2>
        <p className="text-zinc-300 mb-4">
          {t('disclaimer.intro')}
        </p>
        <ul className="text-zinc-400 text-sm space-y-2 mb-6">
          <li className="flex gap-2">
            <span className="text-zinc-500 shrink-0">&bull;</span>
            {t('disclaimer.item1')}
          </li>
          <li className="flex gap-2">
            <span className="text-zinc-500 shrink-0">&bull;</span>
            {t('disclaimer.item2')}
          </li>
          <li className="flex gap-2">
            <span className="text-zinc-500 shrink-0">&bull;</span>
            {t('disclaimer.item3')}
          </li>
          <li className="flex gap-2">
            <span className="text-zinc-500 shrink-0">&bull;</span>
            {t('disclaimer.item4')}
          </li>
          <li className="flex gap-2">
            <span className="text-zinc-500 shrink-0">&bull;</span>
            {t('disclaimer.item5')}
          </li>
          <li className="flex gap-2">
            <span className="text-zinc-500 shrink-0">&bull;</span>
            {t('disclaimer.item6')}
          </li>
        </ul>
        <p className="text-zinc-500 text-xs mb-6">
          {t('disclaimer.acknowledge')}
        </p>
        <button
          onClick={onAccept}
          className="w-full bg-blue-600 hover:bg-blue-500 text-white font-medium py-3 rounded-lg transition-colors cursor-pointer"
        >
          {t('disclaimer.accept')}
        </button>
      </div>
    </div>
  );
}
