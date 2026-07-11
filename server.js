require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const app = express();
app.use(cors()); 
app.use(express.json()); 

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const resolveUserId = async (identifier) => {
  if (identifier.includes('@')) {
    const { data: { users }, error } = await supabase.auth.admin.listUsers();
    if (error) throw new Error("Failed to search users.");
    const user = users.find(u => u.email === identifier.toLowerCase().trim());
    if (!user) throw new Error("User with this email not found.");
    return user.id;
  }
  return identifier; 
};

app.get('/', (req, res) => res.send('🏦 Secure Bank API Running.'));

// --- MANAGER ROUTES ---

app.post('/api/manager/create-user', async (req, res) => {
  try {
    const { email, password, firstName, lastName, phone } = req.body;
    
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email: email.trim(),
      password: password,
      email_confirm: true,
      user_metadata: { first_name: firstName, last_name: lastName, phone: phone }
    });
    if (authError) throw authError;

    const newUserId = authData.user.id;
    const legalName = `${firstName} ${lastName}`.trim(); 

    await supabase.from('profiles').insert([{ 
      id: newUserId, 
      account_status: 'active',
      legal_name: legalName,
      phone: phone 
    }]);
    
    await supabase.from('accounts').insert([{ user_id: newUserId, balance: 0.00, savings_balance: 0.00 }]);

    res.json({ message: `Success! Account created for ${email}.` });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/manager/toggle-status', async (req, res) => {
  try {
    const { identifier, newStatus, managerId } = req.body; 
    const userId = await resolveUserId(identifier);
    
    const { error } = await supabase.from('profiles').update({ account_status: newStatus }).eq('id', userId);
    if (error) throw error;

    // Log to Audit Trail
    if (managerId) {
        await supabase.from('manager_audit_logs').insert([{
            manager_id: managerId,
            action_taken: 'TOGGLE_STATUS',
            target_user_id: userId,
            details: { updated_status: newStatus }
        }]);
    }

    res.json({ message: `Account updated to ${newStatus}` });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/manager/inject-funds', async (req, res) => {
  try {
    const { identifier, amount, description, managerId } = req.body;
    const userId = await resolveUserId(identifier);
    
    const numAmount = parseFloat(amount);
    const isWithdrawal = numAmount < 0;
    const type = isWithdrawal ? 'withdrawal' : 'deposit';
    const absAmount = Math.abs(numAmount); 
    const finalDesc = description ? description : (isWithdrawal ? 'Manual Withdrawal' : 'Manual Deposit');

    const { data: account, error: fetchError } = await supabase.from('accounts').select('account_id, balance').eq('user_id', userId).single();
    if (fetchError) throw fetchError;

    const newBalance = parseFloat(account.balance) + numAmount;
    await supabase.from('accounts').update({ balance: newBalance }).eq('user_id', userId);
    
    // Using single-entry for manual injections
    const txData = {
        type: type, 
        amount: absAmount, 
        status: 'approved', 
        description: finalDesc,
        reference_id: `INJ-${crypto.randomBytes(4).toString('hex').toUpperCase()}`
    };
    if (isWithdrawal) txData.sender_account_id = account.account_id;
    else txData.receiver_account_id = account.account_id;

    await supabase.from('transactions').insert([txData]);

    // Log to Audit Trail
    if (managerId) {
        await supabase.from('manager_audit_logs').insert([{
            manager_id: managerId,
            action_taken: 'INJECT_FUNDS',
            target_user_id: userId,
            details: { amount: numAmount, old_balance: account.balance, new_balance: newBalance, description: finalDesc }
        }]);
    }

    res.json({ message: `Success! ${isWithdrawal ? 'Withdrew' : 'Deposited'} $${absAmount}.` });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// --- UPDATE REWARDS ROUTE (MANAGER) ---
app.post('/api/manager/update-rewards', async (req, res) => {
  try {
    const { identifier, amount, action } = req.body; 
    const userId = await resolveUserId(identifier);

    const { data: account, error: fetchError } = await supabase
      .from('accounts')
      .select('rewards_balance')
      .eq('user_id', userId)
      .single();

    if (fetchError) throw fetchError;

    let currentRewards = parseFloat(account.rewards_balance || 0);
    let numAmount = parseFloat(amount);

    if (action === 'subtract') {
      if (currentRewards < numAmount) {
        return res.status(400).json({ error: "User does not have enough miles." });
      }
      currentRewards -= numAmount;
    } else {
      currentRewards += numAmount;
    }

    const { error: updateError } = await supabase
      .from('accounts')
      .update({ rewards_balance: currentRewards })
      .eq('user_id', userId);

    if (updateError) throw updateError;

    res.json({ message: `Success! Rewards updated. New balance: ${currentRewards.toLocaleString()} Miles.` });
  } catch (err) { 
    res.status(400).json({ error: err.message }); 
  }
});


// --- CLIENT ROUTES ---

app.post('/api/client/transfer', async (req, res) => {
  try {
    const { userId, amount, direction } = req.body; 
    const numAmount = parseFloat(amount);

    if (numAmount <= 0) {
      return res.status(400).json({ error: "Amount must be greater than zero." });
    }

    const { data: acc, error: fetchError } = await supabase
      .from('accounts')
      .select('balance, savings_balance, account_id')
      .eq('user_id', userId)
      .single();
      
    if (fetchError) throw fetchError;

    let newChecking = parseFloat(acc.balance);
    let newSavings = parseFloat(acc.savings_balance || 0);
    let transferDesc = '';

    // --- THE FIX: STRICT BALANCE CHECKING ---
    if (direction === 'c2s') {
       if (newChecking < numAmount) {
         return res.status(400).json({ error: "Insufficient funds in 360 Checking." });
       }
       newChecking -= numAmount; 
       newSavings += numAmount; 
       transferDesc = "Transfer to Savings";
    } else {
       if (newSavings < numAmount) {
         return res.status(400).json({ error: "Insufficient funds in 360 Savings." });
       }
       newChecking += numAmount; 
       newSavings -= numAmount; 
       transferDesc = "Transfer to Checking";
    }

    // Update the balances
    const { error: updateError } = await supabase
      .from('accounts')
      .update({ balance: newChecking, savings_balance: newSavings })
      .eq('user_id', userId);
      
    if (updateError) throw updateError;

    // Log the transaction
    await supabase.from('transactions').insert([{ 
      user_id: userId, 
      type: 'transfer', 
      amount: numAmount, 
      status: 'approved', 
      description: transferDesc,
      sender_account_id: acc.account_id,
      receiver_account_id: acc.account_id
    }]);

    res.json({ success: true });
  } catch (err) { 
    res.status(400).json({ error: err.message }); 
  }
});
// --- EXTERNAL TRANSFER LOGIC (WIRE & ZELLE) ---
const handleExternalTransfer = async (req, res, transferType) => {
  try {
    const { senderUserId, receiverAccountId, amount, description } = req.body;
    const numAmount = parseFloat(amount);

    if (!senderUserId || !receiverAccountId || isNaN(numAmount) || numAmount <= 0) {
      return res.status(400).json({ error: "Invalid transfer parameters." });
    }

    // 1. Get Sender Checking Account
    const { data: account, error: accErr } = await supabase
      .from('accounts')
      .select('account_id, balance')
      .eq('user_id', senderUserId)
      .single();

    if (accErr || !account) return res.status(404).json({ error: "Account not found." });

    // 2. Strict Balance Validation
    if (parseFloat(account.balance) < numAmount) {
      return res.status(400).json({ error: "Insufficient Funds." });
    }

    // 3. Deduct from Checking
    const newBalance = parseFloat(account.balance) - numAmount;
    const { error: updateErr } = await supabase
      .from('accounts')
      .update({ balance: newBalance })
      .eq('account_id', account.account_id);

    if (updateErr) throw updateErr;

    // 4. Log the Transaction
    const referenceId = `${transferType.toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    
    await supabase.from('transactions').insert([{
      sender_account_id: account.account_id,
      receiver_account_id: receiverAccountId, // External routing fallback
      type: transferType, 
      amount: numAmount,
      status: 'approved',
      description: description || `${transferType.charAt(0).toUpperCase() + transferType.slice(1)} Transfer`,
      category: 'Transfer',
      reference_id: referenceId
    }]);

    res.json({ success: true, message: `${transferType} completed successfully.` });
  } catch (err) {
    console.error(`External Transfer Error (${transferType}):`, err);
    res.status(500).json({ error: "Internal server error during transfer." });
  }
};
app.post('/api/client/wire', (req, res) => handleExternalTransfer(req, res, 'wire'));
app.post('/api/client/zelle', (req, res) => handleExternalTransfer(req, res, 'zelle'));

// --- NEW DEBT PAYMENT ROUTE ---
app.post('/api/client/pay-debt', async (req, res) => {
    const { userId, sourceAccountId, debtId, debtType, amount } = req.body;
    const numAmount = parseFloat(amount);

    if (!userId || !sourceAccountId || !debtId || !debtType || isNaN(numAmount) || numAmount <= 0) {
        return res.status(400).json({ error: "Invalid request parameters." });
    }

    try {
        // 1. Fetch checking balance
        const { data: account, error: accErr } = await supabase
            .from('accounts')
            .select('balance')
            .eq('account_id', sourceAccountId)
            .single();

        if (accErr || !account) return res.status(404).json({ error: "Checking account not found." });

        // 2. Validate Funds
        if (parseFloat(account.balance) < numAmount) {
            return res.status(400).json({ error: "Insufficient Funds." });
        }

        // 3. Deduct from Checking Account
        const newCheckingBalance = parseFloat(account.balance) - numAmount;
        const { error: updateAccErr } = await supabase
            .from('accounts')
            .update({ balance: newCheckingBalance })
            .eq('account_id', sourceAccountId);

        if (updateAccErr) throw updateAccErr;

        // 4. Apply payment to the selected Debt Account
        let debtDescription = 'Debt Payment';

        if (debtType === 'credit') {
            const { data: creditAcc, error: credFetchErr } = await supabase
                .from('credit_accounts')
                .select('balance, card_name')
                .eq('id', debtId)
                .single();
                
            if (credFetchErr) throw credFetchErr;
            debtDescription = `Payment to ${creditAcc.card_name}`;

            const { error: credUpdateErr } = await supabase
                .from('credit_accounts')
                .update({ balance: parseFloat(creditAcc.balance) - numAmount })
                .eq('id', debtId);

            if (credUpdateErr) throw credUpdateErr;

        } else if (debtType === 'loan') {
            const { data: loanAcc, error: loanFetchErr } = await supabase
                .from('loan_accounts')
                .select('current_balance, loan_name')
                .eq('id', debtId)
                .single();

            if (loanFetchErr) throw loanFetchErr;
            debtDescription = `Payment to ${loanAcc.loan_name}`;

            const { error: loanUpdateErr } = await supabase
                .from('loan_accounts')
                .update({ current_balance: parseFloat(loanAcc.current_balance) - numAmount })
                .eq('id', debtId);

            if (loanUpdateErr) throw loanUpdateErr;
        } else {
            return res.status(400).json({ error: "Invalid debt type specified." });
        }

        // 5. Log the Transaction in the Master Ledger
        const referenceId = `DP-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
        const { error: txErr } = await supabase
            .from('transactions')
            .insert([{
                sender_account_id: sourceAccountId,
                type: 'withdrawal',
                amount: numAmount,
                status: 'approved',
                description: debtDescription,
                reference_id: referenceId,
                category: 'Transfer'
            }]);

        if (txErr) throw txErr;

        return res.status(200).json({ message: "Payment processed successfully.", newBalance: newCheckingBalance });

    } catch (error) {
        console.error("Debt Payment Error:", error);
        return res.status(500).json({ error: "Internal Server Error while processing payment." });
    }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🏦 Secure Server alive on port ${PORT}`));