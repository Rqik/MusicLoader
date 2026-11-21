import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import styles from './Disclosure.module.scss';

interface DisclosureProps {
  label: string;
  children: ReactNode;
}

export function Disclosure({ label, children }: DisclosureProps) {
  return (
    <details className={styles.disclosure}>
      <summary className={styles['disclosure__summary']}>
        {label}
        <ChevronDown className={styles['disclosure__icon']} size={16} aria-hidden="true" />
      </summary>
      <div className={styles['disclosure__content']}>{children}</div>
    </details>
  );
}
