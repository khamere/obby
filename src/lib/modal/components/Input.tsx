import { type InputHTMLAttributes, useId } from "react";
import { TextInput } from "../../../components/ui/TextInput";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  helperText?: string;
}

export const Input: React.FC<InputProps> = ({
  label,
  error,
  helperText,
  className = "",
  ...props
}) => {
  const errorId = useId();
  return (
    <div className="space-y-2">
      {label && (
        <label className="block text-discord-text-normal text-sm font-medium">
          {label}
        </label>
      )}
      <TextInput
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        {...props}
        className={`w-full bg-discord-dark-400 text-discord-text-normal rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-discord-primary ${className}`}
      />
      {error && (
        <p id={errorId} className="text-red-400 text-sm">
          {error}
        </p>
      )}
      {helperText && !error && (
        <p className="text-discord-text-muted text-sm">{helperText}</p>
      )}
    </div>
  );
};
