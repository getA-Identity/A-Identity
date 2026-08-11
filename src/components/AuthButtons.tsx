import { useNavigate } from 'react-router-dom'
import { Button } from './ui/button'

type AuthButtonsProps = {
  /** Stack vertically (mobile sheet) instead of inline (desktop navbar). */
  stacked?: boolean
  /** Optional callback fired after a button navigates (e.g. close the sheet). */
  onNavigate?: () => void
}

/**
 * The "Start For Free" + "Sign in" pill pair. Shared between the desktop
 * navbar and the mobile sheet so both stay visually identical. Uses the shadcn
 * Button (accent + secondary variants), same look, now consistent everywhere.
 */
export default function AuthButtons({ stacked = false, onNavigate }: AuthButtonsProps) {
  const navigate = useNavigate()

  const go = (path: string) => () => {
    navigate(path)
    onNavigate?.()
  }

  return (
    <div className={stacked ? 'flex flex-col gap-3' : 'flex items-center gap-3'}>
      <Button type="button" variant="default" onClick={go('/signup')}>
        Start For Free
      </Button>
      <Button type="button" variant="secondary" onClick={go('/login')}>
        Sign in
      </Button>
    </div>
  )
}
