import * as Select from '@radix-ui/react-select';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';

export interface ChoiceOption { value: string; label: string; disabled?: boolean }
const EMPTY = '__mianzheng_empty_selection__';

export function ChoiceSelect({ value, onChange, options, label, id, disabled, required, describedBy, invalid, headline = false, className = '' }: {
  value: string; onChange: (value: string) => void; options: ChoiceOption[]; label?: string; id?: string;
  disabled?: boolean; required?: boolean; describedBy?: string; invalid?: boolean; headline?: boolean; className?: string;
}) {
  return (
    <Select.Root value={value || EMPTY} onValueChange={(next) => onChange(next === EMPTY ? '' : next)} disabled={disabled} required={required}>
      <Select.Trigger id={id} aria-label={label} aria-describedby={describedBy} aria-invalid={invalid || undefined}
        className={`${headline ? 'press inline-flex min-h-10 max-w-full items-center justify-between gap-3 rounded-lg border border-line bg-raise-soft px-3 py-2 text-[15px] font-semibold text-paper hover:border-line-hi' : 'field-base flex min-h-10 w-full items-center justify-between gap-3 text-left text-[13px]'} ${className}`}>
        <span className="min-w-0 truncate"><Select.Value placeholder="请选择…" /></span>
        <Select.Icon><ChevronDown className="h-4 w-4 shrink-0 text-mist-dim" strokeWidth={1.8} aria-hidden /></Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content position="popper" sideOffset={6} collisionPadding={12} className="choice-menu z-50 overflow-hidden rounded-xl border border-line bg-ink-900 p-1.5 shadow-xl">
          <Select.ScrollUpButton className="flex h-7 items-center justify-center text-mist"><ChevronUp className="h-4 w-4" /></Select.ScrollUpButton>
          <Select.Viewport>
            {options.map((option) => (
              <Select.Item key={option.value || EMPTY} value={option.value || EMPTY} disabled={option.disabled}
                className="relative flex min-h-10 cursor-pointer select-none items-center rounded-lg py-2 pl-3 pr-9 text-[13px] leading-relaxed text-paper outline-none data-[highlighted]:bg-raise data-[state=checked]:bg-brand/10 data-[disabled]:cursor-not-allowed data-[disabled]:opacity-45">
                <Select.ItemText>{option.label}</Select.ItemText>
                <Select.ItemIndicator className="absolute right-3 flex items-center text-paper"><Check className="h-4 w-4" strokeWidth={2} aria-hidden /></Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Viewport>
          <Select.ScrollDownButton className="flex h-7 items-center justify-center text-mist"><ChevronDown className="h-4 w-4" /></Select.ScrollDownButton>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
